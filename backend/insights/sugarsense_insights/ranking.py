"""Deterministic ranking, de-duplication and lifecycle decisions. No LLM involved."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from .config import Thresholds, Weights
from .models import Candidate


DUPLICATES_OK = {"meal_response", "episode_context", "episode_digest"}   # several of these can be distinct findings in one run


def facts_hash(c: Candidate) -> str:
    """Hash of the rounded evidence. Same hash = same finding; the numbers are already rounded to what the user is shown."""
    payload = [[f.name, f.value, f.unit] for f in c.facts]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:32]


def priority(c: Candidate, novelty: float, w: Weights = Weights()) -> float:
    s = c.scores
    return round(
        w.safety * s.get("safety", 0) + w.evidence * s.get("evidence", 0) + w.recurrence * s.get("recurrence", 0)
        + w.relevance * s.get("relevance", 0) + w.novelty * novelty + w.actionability * s.get("actionability", 0), 3)


@dataclass(frozen=True)
class Decision:
    candidate: Candidate
    action: str                       # new | supersede | drop_duplicate | drop_cooldown
    supersedes: Optional[str] = None  # insight_id
    next_version: int = 1


def _material(old: list[list[Any]], new: Candidate, th: Thresholds) -> bool:
    """True if any numeric evidence moved by at least material_change_pct (relative) or the set of facts changed."""
    if len(old) != len(new.facts):
        return True
    for (name, val, _unit), f in zip(old, new.facts):
        if name != f.name:
            return True
        if isinstance(val, (int, float)) and isinstance(f.value, (int, float)) and not isinstance(val, bool):
            base = max(abs(val), 1.0)
            if abs(f.value - val) / base * 100 >= th.material_change_pct:
                return True
        elif val != f.value:
            return True
    return False


def decide(candidates: list[Candidate], history: list[dict[str, Any]], now: datetime, th: Thresholds, w: Weights = Weights(), engine_version: str | None = None) -> list[Decision]:
    """history rows: dict(insight_id, dedupe_key, category, trigger, facts_hash, content_version, created_at, status, evidence_facts=[[name,value,unit]...])."""
    out: list[Decision] = []
    seen_keys: set[str] = set()
    for c in candidates:
        c.facts_hash = facts_hash(c)
        if c.key in seen_keys:
            continue
        seen_keys.add(c.key)
        same = sorted([h for h in history if h["dedupe_key"] == c.key], key=lambda h: h["content_version"])
        last = same[-1] if same else None
        if last and "paragraph" in last and not last["paragraph"] and last["status"] == "active":
            out.append(Decision(c, "supersede", last["insight_id"], last["content_version"] + 1))   # stored in the older multi-block format: rewrite it as one paragraph
            continue
        if last and last["status"] == "active" and last.get("source") == "rules" and engine_version and last.get("engine_version") not in (None, engine_version):
            out.append(Decision(c, "supersede", last["insight_id"], last["content_version"] + 1))   # the engine's own wording stood in for the model; a newer engine version gets one more try
            continue
        if last and last["facts_hash"] == c.facts_hash and last["status"] in ("active", "superseded"):
            out.append(Decision(c, "drop_duplicate"))
            continue
        if c.trigger == "event":
            recent = [h for h in history if h["category"] == c.category and h["trigger"] == "event" and now - h["created_at"] < timedelta(minutes=th.event_cooldown_min)]
            if recent and not last and not c.python_only:
                out.append(Decision(c, "drop_cooldown"))
                continue
        if last and c.trigger == "event" and not c.python_only and now - last["created_at"] < timedelta(minutes=th.event_cooldown_min):
            out.append(Decision(c, "drop_cooldown"))   # a growing event is not re-announced inside the cooldown; the evening recap carries the update
            continue
        if last:
            if _material(last.get("evidence_facts", []), c, th):
                out.append(Decision(c, "supersede", last["insight_id"], last["content_version"] + 1))
            else:
                out.append(Decision(c, "drop_duplicate"))
            continue
        out.append(Decision(c, "new", None, 1))
    return out


def rank(decisions: list[Decision], history: list[dict[str, Any]], th: Thresholds, w: Weights = Weights()) -> list[Decision]:
    """Order by priority, keep at most max_insights, at most one per category. Never pads."""
    delivered_categories = {h["category"] for h in history if h["status"] == "active"}
    scored = []
    for d in decisions:
        if not d.candidate.claims:
            continue
        novelty = 0.0 if d.candidate.category in delivered_categories and d.action == "supersede" else 1.0
        d.candidate.priority = priority(d.candidate, novelty, w)
        scored.append(d)
    scored.sort(key=lambda d: (-d.candidate.priority, d.candidate.key))
    picked, cats = [], set()
    for d in scored:
        if d.candidate.category in cats and d.candidate.category not in DUPLICATES_OK:
            continue
        picked.append(d)
        cats.add(d.candidate.category)
        if len(picked) >= th.max_insights:
            break
    return picked
