"""Evidence levels and small, dependency-free statistics shared by the detectors.

Levels (the engine assigns them; the model never does, and cannot raise one):
  descriptive  a direct report of recorded data (a stay above range, a meal's measured rise). No inference is made, so no test applies.
  exploratory  a plausible signal that did NOT meet the repeated criteria. Never shown as an insight; kept in the run log so it can mature.
  repeated     seen across independent comparison blocks on at least `MIN_DAYS` days, with a sign-test p-value below ALPHA after correcting for
               the number of hypotheses tested together, and a material effect size.
  validated    repeated AND it survived a time split: the direction found in the EARLIER half of the data holds, with a material effect, in the
               LATER half. This is the in-sample stand-in for out-of-sample validation; it is not a clinical validation and never claims to be one.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

DESCRIPTIVE = "descriptive"
EXPLORATORY = "exploratory"
REPEATED = "repeated"
VALIDATED = "validated"
LEVELS = (DESCRIPTIVE, EXPLORATORY, REPEATED, VALIDATED)

ALPHA = 0.05            # family-wise error rate after Bonferroni correction
MIN_DAYS = 3            # distinct local days a repeated pattern must span

CRITERIA = {
    DESCRIPTIVE: "direct report of recorded readings and records; no inference",
    EXPLORATORY: "a signal that did not meet the repeated criteria; not shown",
    REPEATED: f">= {MIN_DAYS} days, sign test p < {ALPHA} / (hypotheses tested), effect above the material threshold",
    VALIDATED: "repeated, and the earlier half of the data predicts the direction and a material size in the later half",
}

# Existing detectors keep their own, already documented thresholds; this maps them onto the shared vocabulary.
PATTERN_CATEGORIES = {
    "recurring_meal_response", "episode_time_pattern", "morning_rise_pattern", "exercise_association", "sleep_association",
    "insulin_timing_association", "frequent_lows", "baseline_change",
}


def default_level(category: str) -> str:
    """Level for candidates whose detector does not set one: pattern detectors already demand >= 3-7 days of repetition (REPEATED); the rest report records."""
    return REPEATED if category in PATTERN_CATEGORIES else DESCRIPTIVE


def sign_test_p(k: int, n: int) -> float:
    """Two-sided exact binomial (sign) test of k 'same direction' out of n against p = 0.5. Exact, so valid for small n. Ties must be removed by the caller."""
    if n <= 0:
        return 1.0
    k = max(k, n - k)
    tail = sum(math.comb(n, i) for i in range(k, n + 1)) / (2 ** n)
    return min(1.0, 2 * tail)


def bonferroni(p: float, tests: int) -> float:
    return min(1.0, p * max(1, tests))


def median(xs: list[float]) -> float:
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


@dataclass(frozen=True)
class Graded:
    level: str
    p_corrected: float
    reason: str


def grade_directional(blocks: list[tuple[float, float]], material: float, tests: int) -> Graded:
    """blocks: (time_key, effect) per independent comparison block, in time order. Effect > 0 / < 0 gives the direction.
    Returns the level reached and why (the reason is logged when the level is below REPEATED)."""
    effects = [e for _, e in sorted(blocks)]
    nz = [e for e in effects if e != 0]
    n = len(nz)
    if n < 8:
        return Graded(EXPLORATORY, 1.0, f"only {n} comparison blocks (needs 8)")
    pos = sum(1 for e in nz if e > 0)
    p = bonferroni(sign_test_p(pos, n), tests)
    med = median(effects)
    if abs(med) < material:
        return Graded(EXPLORATORY, p, f"median effect {abs(med):.0f} is below the material size {material:.0f}")
    if p >= ALPHA:
        return Graded(EXPLORATORY, p, f"direction not consistent enough (corrected p={p:.3f})")
    half = len(effects) // 2
    first, second = effects[:half], effects[half:]
    same = (med > 0) == (median(second) > 0)
    first_ok = (median(first) > 0) == (med > 0) and abs(median(first)) >= material / 2
    second_ok = same and abs(median(second)) >= material / 2 and sum(1 for e in second if (e > 0) == (med > 0)) / max(1, len(second)) >= 0.6
    if first_ok and second_ok:
        return Graded(VALIDATED, p, "holds in both halves of the period")
    return Graded(REPEATED, p, "consistent overall; not confirmed in both halves")
