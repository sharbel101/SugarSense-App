"""Deterministic validation of LLM output. Nothing the model writes is stored or shown unless every check passes.

Checks are structural first (schema, ids, evidence refs, numbers+units traced to Python's own claims, interval labels,
missing-data consistency, direction consistency, echo of untrusted text) and only then lexical (dose advice, diagnosis, reassurance,
causal wording, verdict labels). Lexical rules are a backstop, not the main defence; they will miss paraphrases, which is why the
model never gets to supply numbers or evidence of its own.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Optional

from .config import SCHEMA_VERSION
from .models import Candidate
from .quality import Availability


@dataclass(frozen=True)
class Violation:
    code: str
    detail: str


# ---- number/unit extraction -------------------------------------------------------------------------------------------
TAG_RE = re.compile(r"\[\s*E\d+(?:\s*,\s*E\d+)*\s*\]|\bE\d+\b")
NUM_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)(?:\s*(mg/dl|mmol/l|%|minutes?|mins?|hours?|hrs?|h\b|grams?|g\b))?", re.I)
UNIT_CLASS = {"mg/dl": "mgdl", "mmol/l": "mmol", "%": "pct", "min": "min", "mins": "min", "minute": "min", "minutes": "min",
              "h": "h", "hr": "h", "hrs": "h", "hour": "h", "hours": "h", "g": "g", "gram": "g", "grams": "g"}


def _pairs(text: str) -> list[tuple[float, Optional[str]]]:
    text = TAG_RE.sub(" ", text)
    out = []
    for m in NUM_RE.finditer(text):
        u = m.group(2).lower() if m.group(2) else None
        out.append((float(m.group(1)), UNIT_CLASS.get(u) if u else None))
    return out


def allowed_pairs(c: Candidate) -> tuple[set[float], set[tuple[float, str]]]:
    nums: set[float] = set()
    unit_pairs: set[tuple[float, str]] = set()
    for text in c.claims + c.limitations + c.boundaries:
        for v, u in _pairs(text):
            nums.add(v)
            if u:
                unit_pairs.add((v, u))
    for f in c.facts:
        if isinstance(f.value, (int, float)) and not isinstance(f.value, bool):
            nums.add(float(f.value))
            if f.unit:
                cls = UNIT_CLASS.get(f.unit.lower().replace("mg/dl", "mg/dl"))
                if cls:
                    unit_pairs.add((float(f.value), cls))
    if c.interval_level is not None:
        v = float(round(c.interval_level * 100))
        nums.add(v)
        unit_pairs.add((v, "pct"))
    return nums, unit_pairs


# ---- lexical backstops ------------------------------------------------------------------------------------------------
DOSE_ADVICE = re.compile(
    r"\b(should|must|need to|needs to|recommend(ed)?|advise[ds]?|consider|please|suggest(ed)?|try to|aim to|make sure)\b[^.\n]{0,60}\b(take|inject|give|administer|bolus|eat|dose|dosing|pre-?bolus|adjust|increase|decrease|skip)\b"
    r"|\b(take|inject|give|administer)\b[^.\n]{0,15}\d+(\.\d+)?\s*(u\b|units?)|\bpre-?bolus", re.I)
DIAGNOSIS = re.compile(r"insulin[- ]resist|basal (rate|insulin|dose)?[^.\n]{0,25}(too|inadequate|insufficient|not enough|needs)|dawn phenomenon|somogyi|diabet(ic|es) (control|compensation)|\byou have\b|ketoacidosis|\bdka\b|gastroparesis|you are (hypo|hyper)", re.I)
REASSURE = re.compile(r"no need to worry|nothing to worry|don'?t worry|not (a )?concern|perfectly (fine|safe|normal)|\bsafe\b|all clear|nothing to be concerned|you(?:'| a)re fine|healthy", re.I)
IGNORE_ALERT = re.compile(r"(ignore|disregard|dismiss|silence|turn off|don'?t (need|have) to (react|respond|act)|no need (to|for) (react|respond|act|alert))[^.\n]{0,40}(alert|alarm|warning|notification)", re.I)
CAUSAL = re.compile(r"\b(because|due to|caused|causes|causing|as a result|resulting from|result of|led to|leading to|driven by|triggered|explained by|attributable|thanks to|owing to)\b", re.I)
VERDICT = re.compile(r"\b(good|bad|great|terrible|poor|excellent|perfect|awful)\s+(day|night|control|numbers|results?|readings?)\b", re.I)
FUTURE = re.compile(r"\bwill\s+(drop|fall|rise|go|be|stay|reach|spike|crash)|going to (drop|fall|rise|spike|crash)", re.I)
RISE_W = re.compile(r"\b(rose|rise|rises|rising|increased?|climbed?|higher|up)\b", re.I)
FALL_W = re.compile(r"\b(fell|fall|falls|falling|dropped?|decreased?|declined?|lower|down)\b", re.I)

CONCEPTS = {
    "sleep": re.compile(r"\bsleep", re.I),
    "wearable": re.compile(r"heart rate|heart-rate|\bhrv\b|variability|stress score|wearable|resting heart|\bsteps\b", re.I),
    "meals": re.compile(r"\bmeals?\b|\bate\b|carb", re.I),
    "insulin": re.compile(r"insulin|bolus|\bdose", re.I),
    "activity": re.compile(r"exercise|workout|activity|activities|\bwalk|\brun(ning)?\b", re.I),
    "forecast": re.compile(r"forecast|predict", re.I),
}
DISCLAIMER = re.compile(r"\b(not|n't|cannot|can't|no)\b[^.]{0,35}\b(show|shows|establish|prove|proves|mean|imply|indicate|determine|say|tell|known)\b|\bnot (a|the) cause\b", re.I)
NEGATION = re.compile(r"\b(no|without|not|missing|unavailable|lack|lacks|lacking|unknown|isn'?t|aren'?t|doesn'?t|don'?t|nothing)\b", re.I)


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


def _shingles(words: list[str], n: int = 4) -> set[tuple[str, ...]]:
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


# ---- schema -----------------------------------------------------------------------------------------------------------
def parse_reply(text: Optional[str]) -> tuple[Optional[list[dict[str, Any]]], list[Violation]]:
    if text is None:
        return None, [Violation("no_output", "no model output")]
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return None, [Violation("invalid_json", "output is not valid JSON (possibly truncated)")]
    if not isinstance(data, dict) or set(data.keys()) != {"results"} or not isinstance(data["results"], list):
        return None, [Violation("schema", "top level must be {results:[...]}")]
    return data["results"], []


def check_schema(item: Any) -> list[Violation]:
    keys = {"schema_version", "insight_id", "explanation", "evidence_refs", "limitation", "insufficient_evidence"}
    if not isinstance(item, dict):
        return [Violation("schema", "result is not an object")]
    v: list[Violation] = []
    if set(item.keys()) != keys:
        v.append(Violation("schema", f"keys must be exactly {sorted(keys)}"))
        return v
    if item["schema_version"] != SCHEMA_VERSION:
        v.append(Violation("schema", "wrong schema_version"))
    if not isinstance(item["insight_id"], str) or not (0 < len(item["insight_id"]) <= 80):
        v.append(Violation("schema", "insight_id"))
    if not isinstance(item["explanation"], str) or len(item["explanation"]) > 300:
        v.append(Violation("length", "explanation must be a string of at most 300 characters"))
    if not isinstance(item["evidence_refs"], list) or len(item["evidence_refs"]) > 6 or not all(isinstance(x, str) and len(x) <= 8 for x in item["evidence_refs"]):
        v.append(Violation("schema", "evidence_refs"))
    if item["limitation"] is not None and (not isinstance(item["limitation"], str) or len(item["limitation"]) > 140):
        v.append(Violation("length", "limitation must be null or at most 140 characters"))
    if not isinstance(item["insufficient_evidence"], bool):
        v.append(Violation("schema", "insufficient_evidence must be boolean"))
    return v


# ---- semantic checks --------------------------------------------------------------------------------------------------
def validate_item(item: Any, cand: Candidate, insight_id: str, avail: dict[str, Availability], other_explanations: list[str] = ()) -> list[Violation]:
    v = check_schema(item)
    if v:
        return v
    if item["insight_id"] != insight_id:
        v.append(Violation("id_mismatch", "insight_id does not match the candidate"))
    if item["insufficient_evidence"]:
        return v  # a minimal, honest result; the caller then uses the deterministic text only
    text = item["explanation"] + " " + (item["limitation"] or "")
    refs = {f.ref for f in cand.facts}
    if not item["evidence_refs"]:
        v.append(Violation("no_evidence", "an explanation must cite at least one evidence ref"))
    for r in item["evidence_refs"]:
        if r not in refs:
            v.append(Violation("unknown_evidence_ref", f"{r} does not exist for this candidate"))
    for r in re.findall(r"\bE\d+\b", text):
        if r not in refs:
            v.append(Violation("unknown_evidence_ref", f"text cites {r} which does not exist"))

    nums, unit_pairs = allowed_pairs(cand)
    for val, unit in _pairs(text):
        if unit == "mmol":
            v.append(Violation("unit", "only mg/dL is supported"))
        elif val not in nums:
            v.append(Violation("unsupported_number", f"{val:g} is not in the computed evidence"))
        elif unit and (val, unit) not in unit_pairs:
            v.append(Violation("unit_mismatch", f"{val:g} {unit} does not match the unit of the evidence"))
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*%\s*(?:probability |prediction |forecast )?(?:interval|confidence)", text, re.I):
        lvl = cand.interval_level
        if lvl is None or float(m.group(1)) != float(round(lvl * 100)):
            v.append(Violation("interval_label", "interval level does not match the forecast's own level"))

    # missing-data consistency: concept statements must agree with the availability assessment and the candidate's own text
    own = " ".join(cand.claims + cand.limitations)
    for key, rx in CONCEPTS.items():
        if not rx.search(text):
            continue
        a = avail.get(key)
        present_in_candidate = bool(rx.search(own))
        for m in rx.finditer(text):
            window = text[max(0, m.start() - 40): m.end() + 40]
            negated = bool(NEGATION.search(window))
            if a is not None and not a.ok and not present_in_candidate and not negated:
                v.append(Violation("missing_data_contradiction", f"mentions {key} although no {key} data exists"))
                break
            # a "no X record" statement is fine when the candidate itself (claims or limitations) says it
            if negated and a is not None and a.ok and not any(rx.search(l) and NEGATION.search(l) for l in cand.limitations + cand.claims):
                v.append(Violation("missing_data_contradiction", f"claims {key} data is missing but it exists"))
                break

    if cand.direction == "rising" and FALL_W.search(text):
        v.append(Violation("contradiction", "describes a fall for a finding that is a rise"))
    if cand.direction == "falling" and RISE_W.search(text) and not re.search(r"\blower|\bhigher\b", text, re.I):
        v.append(Violation("contradiction", "describes a rise for a finding that is a fall"))

    for code, rx in (("dose_advice", DOSE_ADVICE), ("diagnosis", DIAGNOSIS), ("reassurance", REASSURE), ("ignore_alert", IGNORE_ALERT),
                     ("causal_claim", CAUSAL), ("verdict_label", VERDICT), ("future_claim", FUTURE)):
        for m in rx.finditer(text):
            if code == "causal_claim" and DISCLAIMER.search(text[max(0, m.start() - 40): m.start()]):
                continue   # "does not show what caused it" disclaims a cause; it does not assert one
            v.append(Violation(code, f"unsupported wording: '{m.group(0)[:40]}'"))
            break

    if cand.untrusted:
        out_sh = _shingles(_words(text))
        for note in cand.untrusted:
            if out_sh & _shingles(_words(note)):
                v.append(Violation("echo_untrusted", "output repeats user-written text"))
                break
    norm = " ".join(_words(item["explanation"]))
    for o in other_explanations:
        a, b = set(norm.split()), set(" ".join(_words(o)).split())
        if a and b and len(a & b) / len(a | b) >= 0.9:
            v.append(Violation("duplicate_content", "same explanation as another insight"))
            break
    return v
