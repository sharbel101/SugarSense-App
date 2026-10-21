"""Normalized data contract. Every observation carries name, unit, UTC time and source. NULL/None means unknown, never zero.

A source adapter turns whatever a table holds into a Snapshot. The engine only ever sees a Snapshot, so a new data source means
a new adapter and (optionally) new detectors; existing insights keep working when that source is empty.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Optional, Protocol

from .config import Thresholds


@dataclass(frozen=True)
class Reading:
    t: datetime                      # aware, UTC
    mgdl: float                      # unit: mg/dL (only unit supported)
    source: str = "cgm"
    quality: Optional[float] = None  # 0..1 or None = unknown


@dataclass(frozen=True)
class Meal:
    id: str
    t: datetime
    status: str                      # confirmed | manual_entry | draft | cancelled
    carbs_g: Optional[float] = None  # None = unknown
    fat_g: Optional[float] = None
    protein_g: Optional[float] = None
    note: Optional[str] = None       # UNTRUSTED free text


@dataclass(frozen=True)
class Insulin:
    id: str
    t: datetime
    kind: str                        # bolus | correction | basal | other
    units: Optional[float] = None    # administered units; None = unknown
    confirmed: bool = False


@dataclass(frozen=True)
class Activity:
    start: datetime
    kind: str
    duration_min: Optional[float] = None
    intensity: Optional[str] = None
    source: str = "manual"


@dataclass(frozen=True)
class Sleep:
    start: datetime
    end: datetime
    duration_min: Optional[float] = None
    quality: Optional[float] = None  # 0..1; None = unavailable
    source: str = "manual"


@dataclass(frozen=True)
class WearableSample:
    t: datetime
    name: str                        # heart_rate | hrv_rmssd | stress | ... (only what a source really supplies)
    value: float
    unit: str
    source: str


@dataclass(frozen=True)
class ForecastPoint:
    anchor: datetime
    horizon_min: int
    target: datetime
    predicted_mgdl: float
    lower_mgdl: float
    upper_mgdl: float
    interval_level: float            # e.g. 0.80 => "80% interval"


@dataclass(frozen=True)
class UserSettings:
    user_id: str
    timezone: str                    # IANA
    th: Thresholds


@dataclass
class Snapshot:
    settings: UserSettings
    now: datetime
    readings: list[Reading] = field(default_factory=list)
    meals: list[Meal] = field(default_factory=list)
    insulin: list[Insulin] = field(default_factory=list)
    activities: list[Activity] = field(default_factory=list)
    sleeps: list[Sleep] = field(default_factory=list)
    wearables: list[WearableSample] = field(default_factory=list)
    forecast: list[ForecastPoint] = field(default_factory=list)
    therapy: dict[str, Any] = field(default_factory=dict)       # user-entered settings that exist (e.g. morning_resistance: bool); empty = unknown


class SnapshotSource(Protocol):
    def load(self, user_id: str, now: datetime, lookback_days: int) -> Snapshot: ...


# ---- findings -------------------------------------------------------------------------------------------------------
FactKind = Literal["measured", "computed", "forecast", "uncertainty", "context"]


@dataclass(frozen=True)
class Fact:
    ref: str                         # E1, E2 ... unique inside one candidate
    name: str
    value: Any                       # number or short string
    unit: str                        # mg/dL | % | min | h | count | "" ...
    kind: FactKind = "computed"


@dataclass(frozen=True)
class Option:
    """A hedged possibility or a gentle next step the model MAY use for a pattern (menus.py). care_team=True: the text must point to the care team."""
    id: str
    text: str
    care_team: bool = False


@dataclass
class Candidate:
    key: str                         # deterministic dedupe key (category + window bucket)
    category: str
    trigger: Literal["morning", "evening", "event"]
    window: tuple[datetime, datetime]
    facts: list[Fact]
    claims: list[str]                # Python-rendered factual sentences; they contain the authoritative numbers and [E#] refs
    boundaries: list[str]            # what the finding may NOT be interpreted as (association only, not a dose, ...)
    limitations: list[str]           # material data limitations
    coverage: float
    method: str
    quality_flags: list[str] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)  # safety, evidence, recurrence, relevance, actionability (0..1)
    interval_level: Optional[float] = None
    direction: Optional[str] = None  # rising | falling | stable when the candidate states one
    untrusted: list[str] = field(default_factory=list)       # free text that must never be obeyed or echoed
    unit_of: dict[str, str] = field(default_factory=dict)    # extra allowed units
    priority: float = 0.0
    explanations: list[Option] = field(default_factory=list)   # possible explanations the model may offer (hedged)
    suggestions: list[Option] = field(default_factory=list)    # gentle next steps the model may offer
    # filled by the pipeline
    paragraph: Optional[str] = None            # the single paragraph shown on the card (model text that passed validation, else Python's)
    paragraph_source: str = "rules"            # "ai" | "rules"
    reasoning: Optional[str] = None            # back of the card: how it got there (which records were connected, which possibilities were weighed)
    safety: Optional[str] = None               # back of the card: what this insight cannot tell the reader, and who decides insulin questions
    explanation: Optional[str] = None          # legacy mirror of paragraph when source == "ai"
    explanation_limitation: Optional[str] = None
    explanation_refs: list[str] = field(default_factory=list)
    explanations_used: list[str] = field(default_factory=list)
    suggestions_used: list[str] = field(default_factory=list)
    validation_status: str = "not_applicable"
    facts_hash: str = ""

    def fact(self, ref: str) -> Optional[Fact]:
        return next((f for f in self.facts if f.ref == ref), None)
