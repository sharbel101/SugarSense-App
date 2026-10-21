"""Deterministic rendering. Python writes every factual sentence; the validated LLM text, when present, is only an explanation added after them."""
from __future__ import annotations

from .models import Candidate

HEADLINES = {
    "overnight_summary": "Last night",
    "morning_rise_pattern": "A recurring morning rise",
    "previous_day_context": "Recorded yesterday evening",
    "forecast_outlook": "Forecast for the next hours",
    "day_summary": "Today",
    "baseline_change": "Compared with your usual",
    "glucose_excursion": "A stay above range",
    "meal_response": "After a meal",
    "recurring_meal_response": "A recurring meal response",
    "data_quality": "Data quality",
    "exercise_association": "Activity and glucose",
    "sleep_association": "Sleep and glucose",
    "insulin_timing_association": "Insulin records and meals",
    "data_availability": "What the data allows today",
    "episode_digest": "Time outside your range",
    "episode_context": "Around a stay outside range",
    "episode_time_pattern": "Time of day",
    "unexplained_high": "A high with nothing logged before it",
    "low_after_dose": "A low after a dose",
    "post_activity_low": "A low after activity",
    "heading_low": "Glucose may be heading low",
    "frequent_lows": "Lows keep coming back",
    "forecast_performance": "How your forecasts have been doing",
}


def render(c: Candidate) -> dict:
    """The stored/delivered content. 'paragraph' is the ONE text a card shows: the model's validated paragraph (source 'ai') or Python's own (source 'rules').
    facts_text, limitations and evidence stay available for a details view and for audit; the card does not need them."""
    return {
        "headline": HEADLINES.get(c.category, c.category),
        "paragraph": c.paragraph or " ".join(c.claims),
        "source": c.paragraph_source,
        "facts_text": list(c.claims),
        "reasoning": c.reasoning or "",
        "safety": c.safety or "",
        "explanation": c.reasoning or "",          # back of the card: how it was reasoned (model's when validated, else Python's)
        "evidence_refs": list(c.explanation_refs),
        "explanations_used": list(c.explanations_used),
        "suggestions_used": list(c.suggestions_used),
        "limitations": ([c.safety] if c.safety else []) + [l for l in c.limitations if not c.safety or l not in c.safety],   # back of the card: safety first, then data limits
        "validation_status": c.validation_status,
        "disclaimer": "Information from your recorded data, not medical advice. Safety alerts come from the alert system.",
    }


def availability_summary(reasons: dict[str, list[str]]) -> Candidate:
    """Honest 'not enough data' summary used when no insight is supported. Python only; no LLM."""
    lines = []
    for cat, rs in reasons.items():
        for r in rs:
            lines.append(f"{cat}: {r}.")
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    return Candidate(key="availability", category="data_availability", trigger="morning", window=(now, now), facts=[], claims=lines[:6] or ["No insight could be generated because the data does not support one."],
                     boundaries=[], limitations=[], coverage=0.0, method="availability assessment", scores={"safety": 0, "evidence": 1, "relevance": 0.5})
