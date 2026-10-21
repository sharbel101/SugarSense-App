"""Orchestration: snapshot -> quality -> candidates -> rank/dedupe -> (LLM explain -> validate) -> deterministic render -> store.

The LLM is optional at every step. If it is missing, slow, invalid or unavailable, the deterministic Python text is used and the
run still completes. Nothing here reads or writes alert, forecast, glucose or treatment tables.
"""
from __future__ import annotations

import os
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from . import episodes as E
from . import reasoning as R
from . import patterns as P
from .config import ENGINE_VERSION, PROMPT_VERSION, Weights
from .llm import Explainer, candidate_payload
from .models import Candidate, Snapshot, SnapshotSource
from .quality import assess, clean_readings, coverage, Availability
from .ranking import decide, rank
from .render import availability_summary, render
from .store import Store
from .validate import Violation, parse_reply, validate_item
from . import features as F


@dataclass
class RunResult:
    run_key: str
    state: str                          # complete | skipped_complete | busy | failed
    insights: list[dict[str, Any]] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)


def _tz(snap: Snapshot) -> ZoneInfo:
    try:
        return ZoneInfo(snap.settings.timezone)
    except Exception:
        return ZoneInfo("UTC")


def run_key_for(kind: str, snap: Snapshot) -> str:
    d = snap.now.astimezone(_tz(snap)).date().isoformat()
    if kind == "event":
        return f"event:{d}:{int(snap.now.timestamp() // 900)}"   # one event run per 15-minute bucket
    return f"{kind}:{d}"


def build_candidates(kind: str, snap: Snapshot, clean, flags, av: dict[str, Availability]) -> tuple[list[Candidate], dict[str, list[str]]]:
    """Candidates for this kind plus the human-readable reasons nothing else was produced (used for the availability summary)."""
    th, tz = snap.settings.th, _tz(snap)
    d = snap.now.astimezone(tz).date()
    c: list[Candidate] = []
    why: dict[str, list[str]] = {}

    def add(x):
        if x is None:
            return
        c.extend(x if isinstance(x, list) else [x])

    if not av["glucose"].ok:
        why["glucose"] = list(av["glucose"].reasons)
        add(P.data_quality(snap, clean, flags, kind))
        return c, why
    if th.insight_mode == "episodes" and kind in ("morning", "evening"):
        # Episode-first: the model is shown only the stays outside the range (plus whatever context records exist).
        if kind == "morning":
            s, e = F.overnight_window(d, th, tz)
            add(E.episode_digest(snap, clean, flags, s, e, "Last night", f"episodes:overnight:{d.isoformat()}", "morning"))
            ys, ye = F.day_bounds(d - timedelta(days=1), tz)
            add(E.episode_digest(snap, clean, flags, ys, ye, "Yesterday", f"episodes:day:{(d - timedelta(days=1)).isoformat()}", "morning"))
            if not c:
                why["episodes"] = [f"readings covered less than {int(th.min_cov_episode * 100)}% of last night and of yesterday, or too few readings"]
            add(E.episode_context(snap, clean, flags, ys, snap.now, "morning"))
            add(R.unexplained_high(snap, clean, flags, ys, snap.now, "morning"))
            add(R.low_after_dose(snap, clean, flags, ys, snap.now, "morning"))
            add(R.post_activity_low(snap, clean, flags, ys, snap.now, "morning"))
            add(P.previous_day_context(snap, d))
            add(P.forecast_outlook(snap, clean))
            if not av["forecast"].ok:
                why["forecast"] = list(av["forecast"].reasons)
            add(P.sleep_association(snap, clean))
        else:
            s, e = F.day_bounds(d, tz)
            add(E.episode_digest(snap, clean, flags, s, e, "Today so far", f"episodes:day:{d.isoformat()}", "evening"))
            if not c:
                why["episodes"] = [f"today's readings covered less than {int(th.min_cov_episode * 100)}% of the day so far, or too few readings"]
            add(E.episode_context(snap, clean, flags, s, min(e, snap.now), "evening"))
            add(R.unexplained_high(snap, clean, flags, s, min(e, snap.now), "evening"))
            add(R.low_after_dose(snap, clean, flags, s, min(e, snap.now), "evening"))
            add(R.post_activity_low(snap, clean, flags, s, min(e, snap.now), "evening"))
            add(P.meal_responses(snap, clean, s, min(e, snap.now), "evening"))
            add(P.meal_response_recurring(snap, clean, d))
            add(P.exercise_association(snap, clean))
            add(P.insulin_timing_association(snap, clean))
        add(E.episode_time_pattern(snap, clean, d, kind))
        add(P.data_quality(snap, clean, flags, kind))
        if not av["history"].ok:
            why["recurring patterns"] = list(av["history"].reasons)
    elif kind == "morning":
        add(P.overnight_summary(snap, clean, flags, d))
        if not c:
            s, e = F.overnight_window(d, th, tz)
            why["overnight"] = [f"overnight glucose coverage was {int(coverage(clean, s, min(e, snap.now), th) * 100)}% (needs at least {int(th.min_cov_overnight * 100)}%) or too few readings"]
        add(P.morning_rise_recurring(snap, clean, d))
        if not av["history"].ok:
            why["recurring patterns"] = list(av["history"].reasons)
        add(P.previous_day_context(snap, d))
        add(P.forecast_outlook(snap, clean))
        if not av["forecast"].ok:
            why["forecast"] = list(av["forecast"].reasons)
        add(P.sleep_association(snap, clean))
        add(P.data_quality(snap, clean, flags, "morning"))
    elif kind == "evening":
        add(P.day_summary(snap, clean, flags, d))
        if not c:
            s, e = F.day_bounds(d, tz)
            why["today"] = [f"today's glucose coverage was {int(coverage(clean, s, min(e, snap.now), th) * 100)}% (needs at least {int(th.min_cov_day * 100)}%) or too few readings"]
        s, e = F.day_bounds(d, tz)
        add(P.baseline_change(snap, clean, d))
        add(P.excursion_candidates(snap, clean, flags, s, min(e, snap.now), "evening"))
        add(P.meal_responses(snap, clean, s, min(e, snap.now), "evening"))
        add(P.meal_response_recurring(snap, clean, d))
        add(P.exercise_association(snap, clean))
        add(P.insulin_timing_association(snap, clean))
        add(P.data_quality(snap, clean, flags, "evening"))
        if not av["history"].ok:
            why["recurring patterns"] = list(av["history"].reasons)
    else:  # event: Python-only detection first; the LLM is used only if something new and meaningful exists
        add(P.excursion_candidates(snap, clean, flags, snap.now - timedelta(hours=3), snap.now, "event"))
        recent_cut = snap.now - timedelta(minutes=60)
        c[:] = [x for x in c if x.window[1] >= recent_cut]   # only stays that are ongoing or just ended
        add(P.meal_responses(snap, clean, snap.now - timedelta(hours=4), snap.now - timedelta(minutes=th.meal_window_min * 0.66), "event"))
        add(R.unexplained_high(snap, clean, flags, snap.now - timedelta(hours=3), snap.now, "event"))
        # an unexplained high replaces the plain excursion for the same stay (one card per stay)
        starts = {x.window[0] for x in c if x.category == "unexplained_high"}
        c[:] = [x for x in c if not (x.category == "glucose_excursion" and x.window[0] in starts)]
        add(P.data_quality(snap, clean, flags, "event"))
    # one card per stay: a reasoning card (unexplained high, low after a dose or activity) replaces the plain context list for the same stay
    stays = {x.key.rsplit(":", 1)[1] for x in c if x.category in ("unexplained_high", "low_after_dose", "post_activity_low")}
    c[:] = [x for x in c if not (x.category == "episode_context" and x.key.rsplit(":", 1)[1] in stays)]
    for x in c:
        x.trigger = kind  # type: ignore[assignment]
    return c, why


TAG_STRIP = re.compile(r"\s*\[\s*E\d+(?:\s*,\s*E\d+)*\s*\]")


def rules_paragraph(c: Candidate) -> str:
    """Python's own single paragraph: the verified sentences, tags removed. Used whenever the model's paragraph is missing or rejected."""
    return " ".join(TAG_STRIP.sub("", s).strip() for s in c.claims).strip()


def rules_reasoning(c: Candidate) -> str:
    """Python's own 'how this was worked out' text for the back of the card, used when the model's is missing or rejected."""
    parts = [f"How this was worked out: {c.method}."]
    if c.coverage and c.coverage < 0.995:
        parts.append(f"Readings covered {int(c.coverage * 100)}% of the period it looks at.")
    if c.explanations:
        parts.append("Possibilities this kind of pattern is checked against: " + "; ".join(o.text for o in c.explanations) + ".")
    return " ".join(parts)


def rules_safety(c: Candidate) -> str:
    """Python's own safety text: what the insight cannot tell the reader, and who decides insulin questions."""
    s = "This describes your recorded data and cannot show what caused it."
    if any(o.care_team for o in c.explanations + c.suggestions):
        s += " Anything about insulin, background insulin or settings is for your care team to decide."
    return s


def _debug(stats: dict[str, Any], c: Candidate, it: Any, viol: list) -> None:
    """Only when INSIGHTS_DEBUG_REJECTIONS is set (benchmarks, never the timers): keep what was rejected and why, to calibrate the rules."""
    if os.environ.get("INSIGHTS_DEBUG_REJECTIONS"):
        stats.setdefault("rejected", []).append({"category": c.category, "violations": [[x.code, x.detail] for x in viol],
                                                  "text": {k: it.get(k) for k in ("paragraph", "reasoning", "safety", "explanations_used", "suggestions_used")} if isinstance(it, dict) else None})


def _openings(history: list[dict[str, Any]], words: int = 5) -> dict[str, list[str]]:
    """The first words of the last few paragraphs per category, so the model starts differently this time."""
    out: dict[str, list[str]] = {}
    for h in sorted(history, key=lambda r: r.get("created_at"), reverse=True):
        p = h.get("paragraph") or (h.get("content") or {}).get("paragraph")
        if p:
            lst = out.setdefault(h["category"], [])
            if len(lst) < 3:
                lst.append(" ".join(p.split()[:words]))
    return out


def _explain(picked: list, avail, llm: Optional[Explainer], stats: dict[str, Any], openings: Optional[dict[str, list[str]]] = None) -> None:
    """Fill paragraph / validation_status on each picked candidate. Never raises; failures degrade to Python's own paragraph."""
    openings = openings or {}
    ids = {f"I{i + 1}": d.candidate for i, d in enumerate(picked)}
    stats.setdefault("violations", Counter())
    if llm is None or not ids:
        for c in ids.values():
            c.validation_status = "fallback"
        stats["fallbacks"] = len(ids)
        return
    payloads = [candidate_payload(c, iid, openings.get(c.category)) for iid, c in ids.items()]
    reply = llm.explain(payloads)
    stats["llm_calls"] = stats.get("llm_calls", 0) + 1
    stats["llm_latency_s"] = round(stats.get("llm_latency_s", 0.0) + reply.latency_s, 2)
    stats["prompt_tokens"] = (stats.get("prompt_tokens") or 0) + (reply.prompt_tokens or 0)
    stats["completion_tokens"] = (stats.get("completion_tokens") or 0) + (reply.completion_tokens or 0)
    if reply.error:
        stats["llm_error"] = reply.error
        for c in ids.values():
            c.validation_status = "fallback"
        stats["fallbacks"] = len(ids)
        return
    items, pv = parse_reply(reply.text)
    for v in pv:
        stats["violations"][v.code] += 1
    by_id: dict[str, Any] = {}
    if items is not None:
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("insight_id"), str):
                by_id.setdefault(it["insight_id"], it)
    accepted: list[str] = []
    failed: dict[str, list[Violation]] = {}
    for iid, c in ids.items():
        it = by_id.get(iid)
        viol = [Violation("missing_result", "no result for this candidate")] if it is None else validate_item(it, c, iid, avail, accepted)
        if viol:
            failed[iid] = viol
            _debug(stats, c, it, viol)
            for v in viol:
                stats["violations"][v.code] += 1
        else:
            _accept(c, it, accepted)
    # one corrective retry per failed item (only when the model answered but wrongly; never after timeout/unavailable)
    for iid, viol in failed.items():
        c = ids[iid]
        codes = ", ".join(sorted({v.code for v in viol}))
        r2 = llm.explain([candidate_payload(c, iid, openings.get(c.category))], correction=f"Your previous answer was rejected ({codes}). Use only numbers exactly as in the claims; mention only the listed explanations and next steps, as possibilities, and point insulin topics to the care team; one plain paragraph; no doses, no timings, no causes stated as fact. Return the same JSON format.")
        stats["llm_calls"] += 1
        stats["retries"] = stats.get("retries", 0) + 1
        stats["llm_latency_s"] = round(stats["llm_latency_s"] + r2.latency_s, 2)
        stats["completion_tokens"] = (stats.get("completion_tokens") or 0) + (r2.completion_tokens or 0)
        ok = False
        if not r2.error:
            items2, pv2 = parse_reply(r2.text)
            it2 = items2[0] if items2 else None
            viol2 = pv2 or ([Violation("missing_result", "no result")] if it2 is None else validate_item(it2, c, iid, avail, accepted))
            if not viol2:
                _accept(c, it2, accepted)
                ok = True
            else:
                _debug(stats, c, it2, viol2)
                for v in viol2:
                    stats["violations"][v.code] += 1
        else:
            stats["llm_error"] = r2.error
        if not ok:
            c.validation_status = "fallback"
            stats["fallbacks"] = stats.get("fallbacks", 0) + 1


def _accept(c: Candidate, it: dict[str, Any], accepted: list[str]) -> None:
    if it["insufficient_evidence"]:
        c.validation_status = "fallback"
        return
    # citation tags are for the validator and for storage, not for the reader: keep them in evidence_refs, strip them from the text
    c.paragraph = TAG_STRIP.sub("", it["paragraph"]).strip()
    c.paragraph_source = "ai"
    c.reasoning = TAG_STRIP.sub("", it["reasoning"]).strip()
    c.safety = TAG_STRIP.sub("", it["safety"]).strip()
    c.explanation = c.reasoning            # the 'explanation' field now carries how the insight was reasoned (back of the card)
    c.explanation_refs = list(it["evidence_refs"])
    c.explanations_used = list(it["explanations_used"])
    c.suggestions_used = list(it["suggestions_used"])
    c.validation_status = "valid"
    accepted.append(c.paragraph)


def run(kind: str, user_id: str, now: datetime, source: SnapshotSource, store: Store, llm: Optional[Explainer], *, model_version: Optional[str] = None,
        weights: Weights = Weights(), persist: bool = True) -> RunResult:
    snap = source.load(user_id, now, 14)
    th = snap.settings.th
    key = run_key_for(kind, snap)
    if persist:
        run_id, state = store.claim_run(user_id, key, kind, now, ENGINE_VERSION, PROMPT_VERSION, model_version)
        if state == "complete":
            return RunResult(key, "skipped_complete")
        if state == "busy" or run_id is None:
            return RunResult(key, "busy")
    else:
        run_id = -1
    stats: dict[str, Any] = {"engine_version": ENGINE_VERSION, "prompt_version": PROMPT_VERSION, "kind": kind}
    t0 = time.monotonic()
    try:
        clean, flags = clean_readings(snap.readings, now, th)
        av = assess(snap, clean, flags)
        cands, why = build_candidates(kind, snap, clean, flags, av)
        history = store.history(user_id, now - timedelta(days=14)) if persist else []
        decisions = decide(cands, history, now, th, weights)
        stats["candidates"] = len(cands)
        stats["dropped_duplicate"] = sum(1 for d in decisions if d.action == "drop_duplicate")
        stats["dropped_cooldown"] = sum(1 for d in decisions if d.action == "drop_cooldown")
        picked = rank([d for d in decisions if d.action in ("new", "supersede")], history, th, weights)
        if not picked and kind != "event" and not any(d.action == "drop_duplicate" for d in decisions):
            summ = availability_summary(why)
            summ.trigger = kind  # type: ignore[assignment]
            summ.key = f"availability:{key}"
            picked = rank(decide([summ], history, now, th, weights), history, th, weights)
        for d in picked:
            d.candidate.paragraph = rules_paragraph(d.candidate)      # the defaults; replaced only by validated model text
            d.candidate.reasoning = rules_reasoning(d.candidate)
            d.candidate.safety = rules_safety(d.candidate)
        real = [d for d in picked if d.candidate.category != "data_availability"]
        _explain(real, av, llm, stats, _openings(history))
        out = []
        for d in picked:
            c = d.candidate
            if c.category == "data_availability":
                c.validation_status = "not_applicable"
            ttl = th.event_ttl_h if kind == "event" else th.scheduled_ttl_h
            rec = {
                "category": c.category, "trigger": kind, "dedupe_key": c.key, "facts_hash": c.facts_hash, "content_version": d.next_version,
                "supersedes_insight_id": d.supersedes, "observation_start": c.window[0], "observation_end": c.window[1], "priority": c.priority,
                "validation_status": c.validation_status, "created_at": now, "expires_at": now + timedelta(hours=ttl),
                "evidence": {"facts": [{"ref": f.ref, "name": f.name, "value": f.value, "unit": f.unit, "kind": f.kind} for f in c.facts], "coverage": round(c.coverage, 3),
                             "quality_flags": c.quality_flags, "method": c.method, "boundaries": c.boundaries, "window": [c.window[0].isoformat(), c.window[1].isoformat()]},
                "content": render(c),
            }
            rec["evidence_facts"] = [[f.name, f.value, f.unit] for f in c.facts]
            if persist:
                if d.supersedes:
                    store.supersede(d.supersedes, now)
                rec["insight_id"] = store.save_insight(user_id, run_id, rec)
            out.append(rec)
        stats["insights"] = len(out)
        stats["categories"] = sorted(r["category"] for r in out)
        stats["fallbacks"] = stats.get("fallbacks", 0)
        stats["violations"] = dict(stats.get("violations", {}))
        stats["total_s"] = round(time.monotonic() - t0, 2)
        if persist:
            store.finish_run(run_id, "complete", stats, now)
        return RunResult(key, "complete", out, stats)
    except Exception as e:  # never leave a run 'running' and never leak the payload into the log
        stats["error"] = type(e).__name__
        if persist:
            store.finish_run(run_id, "failed", stats, now)
        return RunResult(key, "failed", [], stats)
