"""Deterministic validation of the model's paragraph. Nothing it writes is stored or shown unless every check passes.

Structural checks first (schema, one clean paragraph, ids, evidence refs, every number and unit traced to Python's own claims, interval labels,
only the explanations and next steps Python listed for this pattern, missing-data consistency, direction, echo of untrusted text), then lexical backstops
(dose and timing language, diagnoses, reassurance, ignoring alerts, causes stated as fact, verdict labels, predictions). The lexical rules are a
backstop and will miss paraphrases; the main defence is that the model never supplies numbers, evidence, explanations or next steps of its own.
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
WORD_NUM = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}   # spelled counts must trace to evidence too


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
                cls = UNIT_CLASS.get(f.unit.lower())
                if cls:
                    unit_pairs.add((float(f.value), cls))
    if c.interval_level is not None:
        v = float(round(c.interval_level * 100))
        nums.add(v)
        unit_pairs.add((v, "pct"))
    return nums, unit_pairs


# ---- lexical backstops ------------------------------------------------------------------------------------------------
HARD_DOSE = re.compile(
    r"\d+(?:\.\d+)?\s*(?:u\b|units?\b|iu\b)"                                                          # a number of insulin units
    r"|\b(?:inject|administer|give yourself|take (?:more|less|extra|another))\b"
    r"|\b(?:increase|decrease|reduce|double|halve|skip|stop|change|adjust|cut)\w*\s+(?:your\s+|the\s+|a\s+)?(?:\w+\s+){0,2}(?:insulin|dose|doses|basal|bolus|setting)"
    r"|\b(?:wait|waiting)\b[^.]{0,20}\d+\s*(?:min|minutes)", re.I)
SOFT_ADVICE = re.compile(r"\b(?:should|must|need to|needs to|have to|you ought|make sure|aim to)\b", re.I)
DIAGNOSIS_ALWAYS = re.compile(r"ketoacidosis|\bdka\b|gastroparesis|somogyi|dawn phenomenon|you have (?:diabetes|type|hypo|hyper)|you are (?:hypo|hyper)", re.I)
DIAGNOSIS_HEDGEABLE = re.compile(r"insulin[- ]resist(?:ance|ant)|basal (?:rate|insulin|dose)?[^.\n]{0,25}(?:too (?:low|high)|inadequate|insufficient|not enough)", re.I)
REASSURE = re.compile(r"no need to worry|nothing to worry|don'?t worry|not (?:a )?concern|perfectly (?:fine|safe|normal)|\bsafe\b|all clear|nothing to be concerned|you(?:'| a)re fine|healthy|nothing to be done", re.I)
IGNORE_ALERT = re.compile(r"(?:ignore|disregard|dismiss|silence|turn off|don'?t (?:need|have) to (?:react|respond|act)|no need (?:to|for) (?:react|respond|act|alert))[^.\n]{0,40}(?:alert|alarm|warning|notification)", re.I)
CAUSAL = re.compile(r"\b(?:because|due to|caused|causes|causing|as a result|resulting from|result of|led to|leading to|driven by|triggered|explained by|attributable|thanks to|owing to|this means|which means|that means|this shows|this proves|this indicates|this is a sign|which is why|that'?s why)\b", re.I)
ASSERT_BAD_INSULIN = re.compile(r"\b(?:is|was|are|were|has|have)\s+(?:expired|gone off|spoiled|ineffective|bad|faulty|off)\b|\binsulin (?:is|was) (?:expired|bad|spoiled)", re.I)
VERDICT = re.compile(r"\b(?:good|bad|great|terrible|poor|excellent|perfect|awful)\s+(?:day|night|control|numbers|results?|readings?)\b", re.I)
FUTURE = re.compile(r"\bwill\s+(?:drop|fall|rise|go|be|stay|reach|spike|crash|happen)|going to (?:drop|fall|rise|spike|crash)", re.I)
HEDGE = re.compile(r"\b(?:could|may|might|possible|possibly|possibility|perhaps|can be|can lead|can push|can raise|can make|worth|one thing|it could|it may|sometimes|if )\b", re.I)
CARE_TEAM = re.compile(r"care team|diabetes team|doctor|clinician|healthcare|health care|nurse|endocrinolog|educator|medical team", re.I)
ADVICE_VERB = re.compile(r"\b(?:worth|consider|try|discuss|raise|ask|talk|check|review|keep an eye|logging|note down|log)\b", re.I)
INSULIN_TOPIC = re.compile(r"\b(?:insulin|basal|bolus|dose|doses|dosing|setting|settings)\b|pre-?bolus", re.I)
STORAGE_ONLY = re.compile(r"expiry|expir|storage|stored|rotat|injection site|pump site|pen or vial", re.I)
RISE_W = re.compile(r"\b(?:rose|risen|climbed|spiked|shot up|jumped)\b", re.I)
FALL_W = re.compile(r"\b(?:fell|dropped|plunged|plummeted|crashed|declined)\b", re.I)
UNLISTED = [  # (regex, option ids that justify mentioning it); also fine if the candidate's own claims already say it
    (re.compile(r"\b(?:stress|stressed|illness|sick|infection|poor night|bad night|lack of sleep|short night|slept badly|sleep loss)\b", re.I), {"stress_illness_sleep", "log_context"}),
    (re.compile(r"\b(?:expiry|expired|past its|stored|storage|too warm|too cold|injection site|pump site|tired site|rotating)\b", re.I), {"insulin_effectiveness", "check_insulin_storage"}),
    (re.compile(r"\b(?:basal|background insulin|long-acting)\b", re.I), {"basal_coverage", "discuss_basal", "morning_setting", "discuss_morning_setting"}),
    (re.compile(r"\bhormon", re.I), {"early_morning_hormones"}),
    (re.compile(r"pre-?bolus|insulin earlier|earlier insulin|mealtime insulin|insulin before (?:the |a )?meal|dose (?:earlier|before)", re.I), {"discuss_prebolus", "insulin_timing"}),
    (re.compile(r"\b(?:snack|late meal|not logged|wasn'?t logged|unlogged|forgot)\b", re.I), {"unlogged_food", "log_context"}),
    (re.compile(r"\b(?:portion|meal size|smaller meal|bigger meal|size of the meal)\b", re.I), {"meal_size", "discuss_meal_size"}),
    (re.compile(r"fast-?digesting|fast carb|sugary|refined carb", re.I), {"meal_composition", "discuss_meal_size"}),
    (re.compile(r"\b(?:exercise|workout|more sensitive|sensitivity)\b", re.I), {"activity_sensitivity", "watch_after_activity"}),
    (re.compile(r"\b(?:overlap|still acting|stack|stacked|earlier dose)\b", re.I), {"dose_overlap"}),
]
CONCEPTS = {
    "sleep": re.compile(r"\bsleep", re.I),
    "wearable": re.compile(r"heart rate|heart-rate|\bhrv\b|variability|stress score|wearable|resting heart|\bsteps\b", re.I),
    "meals": re.compile(r"\bmeals?\b|\bate\b|carb", re.I),
    "insulin": re.compile(r"insulin|bolus|\bdose", re.I),
    "activity": re.compile(r"exercise|workout|activity|activities|\bwalk|\brun(ning)?\b", re.I),
    "forecast": re.compile(r"forecast|predict", re.I),
}
NEGATION = re.compile(r"\b(?:no|without|not|missing|unavailable|lack|lacks|lacking|unknown|isn'?t|aren'?t|doesn'?t|don'?t|nothing)\b", re.I)
DISCLAIMER = re.compile(r"\b(?:not|n't|cannot|can't|no)\b[^.]{0,35}\b(?:show|shows|establish|prove|proves|mean|imply|indicate|determine|say|tell|known)\b|\bnot (?:a|the) cause\b", re.I)


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


def _shingles(words: list[str], n: int = 4) -> set[tuple[str, ...]]:
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


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


KEYS = {"schema_version", "insight_id", "paragraph", "reasoning", "safety", "evidence_refs", "explanations_used", "suggestions_used", "insufficient_evidence"}


def check_schema(item: Any) -> list[Violation]:
    if not isinstance(item, dict):
        return [Violation("schema", "result is not an object")]
    if set(item.keys()) != KEYS:
        return [Violation("schema", f"keys must be exactly {sorted(KEYS)}")]
    v: list[Violation] = []
    if item["schema_version"] != SCHEMA_VERSION:
        v.append(Violation("schema", "wrong schema_version"))
    if not isinstance(item["insight_id"], str) or not (0 < len(item["insight_id"]) <= 80):
        v.append(Violation("schema", "insight_id"))
    for k, mx in (("paragraph", 760), ("reasoning", 700), ("safety", 380)):
        if not isinstance(item[k], str) or len(item[k]) > mx:
            v.append(Violation("length", f"{k} must be a string of at most {mx} characters"))
    for k, mx in (("evidence_refs", 8), ("explanations_used", 4), ("suggestions_used", 3)):
        if not isinstance(item[k], list) or len(item[k]) > mx or not all(isinstance(x, str) and len(x) <= 40 for x in item[k]):
            v.append(Violation("schema", k))
    if not isinstance(item["insufficient_evidence"], bool):
        v.append(Violation("schema", "insufficient_evidence must be boolean"))
    return v


# ---- semantic checks --------------------------------------------------------------------------------------------------
def validate_item(item: Any, cand: Candidate, insight_id: str, avail: dict[str, Availability], other_paragraphs: list[str] = ()) -> list[Violation]:
    v = check_schema(item)
    if v:
        return v
    if item["insight_id"] != insight_id:
        v.append(Violation("id_mismatch", "insight_id does not match the candidate"))
    if item["insufficient_evidence"]:
        return v  # an honest minimal result; the caller then uses Python's own paragraph
    para, reasoning, safety = item["paragraph"].strip(), item["reasoning"].strip(), item["safety"].strip()

    # the front is one clean paragraph; the two back texts are short plain prose
    for name, s, lo, hi, raw in (("paragraph", para, 18, 125, item["paragraph"]), ("reasoning", reasoning, 12, 150, item["reasoning"]), ("safety", safety, 6, 85, item["safety"])):
        n = len(s.split())
        if "\n" in raw or re.search(r"(?m)^\s*(?:[-*•#]|\d+[.)])\s", raw) or "**" in s or "##" in s:
            v.append(Violation("format", f"{name} must be plain prose (no line breaks, bullets, headings or markdown)"))
        if n < lo or n > hi:
            v.append(Violation("length", f"{name} has {n} words; expected about {lo} to {hi}"))
    if len(_sentences(para)) > 7:
        v.append(Violation("length", "too many sentences"))
    text = para + " " + reasoning + " " + safety        # every rule below applies to all three texts

    refs = {f.ref for f in cand.facts}
    if not item["evidence_refs"]:
        v.append(Violation("no_evidence", "a paragraph must cite at least one evidence ref"))
    for r in list(item["evidence_refs"]) + re.findall(r"\bE\d+\b", text):
        if r not in refs:
            v.append(Violation("unknown_evidence_ref", f"{r} does not exist for this candidate"))

    nums, unit_pairs = allowed_pairs(cand)
    for val, unit in _pairs(text):
        if unit == "mmol":
            v.append(Violation("unit", "only mg/dL is supported"))
        elif val not in nums:
            v.append(Violation("unsupported_number", f"{val:g} is not in the computed evidence"))
        elif unit and (val, unit) not in unit_pairs:
            v.append(Violation("unit_mismatch", f"{val:g} {unit} does not match the unit of the evidence"))
    for w in re.findall(r"\b(two|three|four|five|six|seven|eight|nine|ten)\b", text, re.I):
        if float(WORD_NUM[w.lower()]) not in nums:
            v.append(Violation("unsupported_number", f"'{w}' is not in the computed evidence"))
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*%\s*(?:probability |prediction |forecast )?(?:interval|confidence)", text, re.I):
        lvl = cand.interval_level
        if lvl is None or float(m.group(1)) != float(round(lvl * 100)):
            v.append(Violation("interval_label", "interval level does not match the forecast's own level"))

    # only the reasoning Python listed for this pattern
    exp_ids = {o.id for o in cand.explanations}
    sug_ids = {o.id for o in cand.suggestions}
    for i in item["explanations_used"]:
        if i not in exp_ids:
            v.append(Violation("unlisted_explanation", f"explanation id '{i}' was not offered for this finding"))
    for i in item["suggestions_used"]:
        if i not in sug_ids:
            v.append(Violation("unlisted_suggestion", f"next-step id '{i}' was not offered for this finding"))
    used = set(item["explanations_used"]) | set(item["suggestions_used"])
    own_claims = " ".join(cand.claims + cand.limitations)
    for rx, ids in UNLISTED:
        if rx.search(text) and not (used & ids) and not rx.search(own_claims):
            v.append(Violation("unlisted_reasoning", f"mentions '{rx.search(text).group(0)[:30]}' which was not offered for this finding"))
    options = {o.id: o for o in cand.explanations + cand.suggestions}
    needs_care = any(options[i].care_team for i in used if i in options)
    if needs_care and not CARE_TEAM.search(text):
        v.append(Violation("care_team_missing", "an insulin or settings topic must point to the care team"))
    if needs_care and not CARE_TEAM.search(safety):
        v.append(Violation("care_team_missing", "the safety text must point to the care team when an insulin or settings topic is involved"))
    if not re.search(r"\b(?:not|cannot|can't|no)\b", safety, re.I):
        v.append(Violation("safety_missing_limit", "the safety text must say what the insight cannot tell the reader"))
    for s in _sentences(text):
        if ADVICE_VERB.search(s) and INSULIN_TOPIC.search(s) and not CARE_TEAM.search(s) and not STORAGE_ONLY.search(s) and not re.search(r"\bhave been logged|were logged|was logged|is logged\b", s, re.I):
            v.append(Violation("care_team_missing", "advice about insulin or settings must point to the care team in the same sentence"))
            break
    if item["explanations_used"] and not HEDGE.search(text):
        v.append(Violation("not_hedged", "possible explanations must be worded as possibilities"))

    # missing-data consistency
    own = " ".join(cand.claims + cand.limitations + [o.text for o in cand.explanations + cand.suggestions])
    for key, rx in CONCEPTS.items():
        if not rx.search(text):
            continue
        a = avail.get(key)
        present = bool(rx.search(own))
        for m in rx.finditer(text):
            window = text[max(0, m.start() - 40): m.end() + 40]
            negated = bool(NEGATION.search(window))
            says_missing = negated and bool(re.search(r"record|data|log|entr|reading", window, re.I))
            if a is not None and not a.ok and not present and not negated:
                v.append(Violation("missing_data_contradiction", f"mentions {key} although no {key} data exists"))
                break
            if says_missing and a is not None and a.ok and not any(rx.search(l) and NEGATION.search(l) for l in cand.limitations + cand.claims):
                v.append(Violation("missing_data_contradiction", f"claims {key} data is missing but it exists"))
                break

    if cand.direction == "rising" and FALL_W.search(text) and not re.search(r"\b(?:back|returned|settled|came)\b", text, re.I):
        v.append(Violation("contradiction", "describes a fall for a finding that is a rise"))
    if cand.direction == "falling" and RISE_W.search(text) and not re.search(r"\b(?:back|returned|recovered|then)\b", text, re.I):
        v.append(Violation("contradiction", "describes a rise for a finding that is a fall"))

    for code, rx in (("dose_advice", HARD_DOSE), ("diagnosis", DIAGNOSIS_ALWAYS), ("reassurance", REASSURE), ("ignore_alert", IGNORE_ALERT),
                     ("verdict_label", VERDICT), ("future_claim", FUTURE), ("asserted_insulin_fault", ASSERT_BAD_INSULIN)):
        m = rx.search(text)
        if m and code == "dose_advice":
            # "without adjusting any dose", "changes to insulin settings must be decided by your care team": denying or handing over is fine; numbers of units and "inject/take more" never are
            m = next((x for s_ in _sentences(text) for x in [rx.search(s_)] if x and (re.search(r"\d|inject|administer|give yourself|take", x.group(0), re.I) or not (NEGATION.search(s_) or re.search(r"\bdecid", s_, re.I)))), None)
        if m:
            v.append(Violation(code, f"unsupported wording: '{m.group(0)[:40]}'"))
    has_setting = any(f.name == "morning_resistance_setting" for f in cand.facts)
    for s in _sentences(text):
        hedged = bool(HEDGE.search(s))
        for m in CAUSAL.finditer(s):
            if hedged or DISCLAIMER.search(s[max(0, m.start() - 40): m.start()]):
                continue
            # "does not confirm what caused it", "causes remain unknown", "Because no explanations are listed": the word is used to deny or to point onward, not to claim
            if NEGATION.search(s) or (m.group(0).lower() == "because" and CARE_TEAM.search(s)):
                continue
            v.append(Violation("causal_claim", f"cause stated as fact: '{m.group(0)[:40]}'"))
            break
        m = DIAGNOSIS_HEDGEABLE.search(s)
        if m and not (hedged or (has_setting and re.search(r"setting|option|switched on|turned on", s, re.I))):
            v.append(Violation("diagnosis", f"unsupported wording: '{m.group(0)[:40]}'"))
        if SOFT_ADVICE.search(s) and INSULIN_TOPIC.search(s) and not CARE_TEAM.search(s):
            v.append(Violation("dose_advice", "insulin advice stated as an instruction"))

    if cand.untrusted:
        out_sh = _shingles(_words(text))
        for note in cand.untrusted:
            if out_sh & _shingles(_words(note)):
                v.append(Violation("echo_untrusted", "output repeats user-written text"))
                break
    norm = " ".join(_words(para))
    for o in other_paragraphs:
        a, b = set(norm.split()), set(" ".join(_words(o)).split())
        if a and b and len(a & b) / len(a | b) >= 0.85:
            v.append(Violation("duplicate_content", "same paragraph as another insight"))
            break
    return v
