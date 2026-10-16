/**
 * Logged events (meal, insulin) - pure types, validation, time handling and display text.
 *
 * Shapes follow root CLAUDE.md section 3 and the server contract in
 * `backend/src/forecasting/events.schema.ts`: timestamps are UTC with the local offset recorded
 * separately, a dose actually taken is user-entered and never derived from a suggestion, "unknown"
 * is expressed by omitting a field (never by 0), and an AI-produced carb number keeps its original
 * estimate next to the person's correction.
 *
 * No imports, so plain-Node tests can run it.
 */

export type InsulinType = 'rapid' | 'ultra_rapid' | 'short' | 'long' | 'other';
export const INSULIN_TYPES: { value: InsulinType; label: string }[] = [
  { value: 'rapid', label: 'Rapid-acting' },
  { value: 'ultra_rapid', label: 'Ultra-rapid' },
  { value: 'short', label: 'Short-acting' },
  { value: 'long', label: 'Long-acting' },
  { value: 'other', label: 'Other' },
];
/** Only these act as meal or correction insulin in the forecast (server rule). */
export const MEAL_ACTING_TYPES: InsulinType[] = ['rapid', 'ultra_rapid'];

/** What the insulin was for. The server never uses `basal` as a meal dose. */
export type InsulinKind = 'bolus' | 'correction' | 'basal';
export const INSULIN_KINDS: { value: InsulinKind; label: string }[] = [
  { value: 'bolus', label: 'With a meal' },
  { value: 'correction', label: 'Correction' },
  { value: 'basal', label: 'Long-acting / basal' },
];

export type AbsorptionClass = 'fast' | 'medium' | 'slow';
export const ABSORPTION_OPTIONS: { value: AbsorptionClass | 'unset'; label: string }[] = [
  { value: 'unset', label: 'Not sure' },
  { value: 'fast', label: 'Fast (juice, sweets)' },
  { value: 'medium', label: 'Normal' },
  { value: 'slow', label: 'Slow (fatty or large)' },
];

/** `gemini` = the AI estimate unchanged; `gemini_edited` = the person corrected it; `manual` = typed in. */
export type MealSource = 'gemini' | 'gemini_edited' | 'manual';

type Base = {
  /** Client-generated id, sent as `clientId` and reused on retry so a repeat can never create a second event. */
  id: string;
  occurredAtUtc: string;
  utcOffsetMin: number;
  notes: string | null;
};

export type MealEvent = Base & {
  kind: 'meal';
  label: string;
  carbsG: number;
  fatG: number | null;
  proteinG: number | null;
  fiberG: number | null;
  absorptionClass: AbsorptionClass | null;
  timeApproximate: boolean;
  source: MealSource;
  /** The AI's original total, kept next to the person's value; null for manual entries. */
  aiCarbsG: number | null;
};

export type InsulinEvent = Base & {
  kind: 'insulin';
  insulinKind: InsulinKind;
  /** Units the person says they actually took. 0 only for an explicit "I took none". */
  unitsAdministered: number;
  insulinType: InsulinType;
  /** `uncertain` = taken, but amount or time approximate. */
  confirmation: 'confirmed' | 'uncertain';
  timingUncertain: boolean;
  /** Server id of the meal this dose is for, when the person chose one. */
  mealId: string | null;
  /** Kept on the device only: the server has no field for it. */
  glucoseMgdl: number | null;
};

export type LoggedEvent = MealEvent | InsulinEvent;

export const LIMITS = {
  maxCarbsG: 400,
  /** Sanity cap only - the person's real max_bolus setting does not exist in the app yet. */
  maxInsulinUnits: 50,
  maxMacroG: 300,
  minGlucoseMgdl: 20,
  maxGlucoseMgdl: 600,
  maxNotesChars: 300,
  /** The server rejects entries older than this. */
  maxAgeMin: 48 * 60,
} as const;

export function newEventId(): string {
  const rnd = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `${Date.now().toString(16)}-${rnd()}-${rnd()}`;
}

/** The server accepts 8-80 characters of A-Z a-z 0-9 . _ - as `clientId`. */
export function isValidClientId(id: string): boolean {
  return /^[A-Za-z0-9._-]{8,80}$/.test(id);
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Parses a typed decimal ("12", "12.5", "12,5"); `null` when empty or not a finite number. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------------------- time

export type TimeChoice =
  | { mode: 'minutesAgo'; minutes: number }
  | { mode: 'clock'; hhmm: string };

export type ResolvedTime = { utcIso: string; utcOffsetMin: number };

/**
 * Turns the person's time choice into a UTC instant plus the local offset (minutes east of UTC).
 * A typed clock time means "today", or yesterday when that clock time is still in the future.
 */
export function resolveEventTime(choice: TimeChoice, now: Date): ResolvedTime | { error: string } {
  const utcOffsetMin = -now.getTimezoneOffset();
  if (choice.mode === 'minutesAgo') {
    if (!Number.isFinite(choice.minutes) || choice.minutes < 0) return { error: 'Choose a valid time.' };
    if (choice.minutes > LIMITS.maxAgeMin) return { error: 'Entries can be at most 48 hours old.' };
    return { utcIso: new Date(now.getTime() - choice.minutes * 60_000).toISOString(), utcOffsetMin };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(choice.hhmm.trim());
  if (!match) return { error: 'Enter the time as HH:MM, for example 14:30.' };
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return { error: 'Enter a valid time, for example 14:30.' };
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
  return { utcIso: at.toISOString(), utcOffsetMin };
}

export function formatEventTime(utcIso: string): string {
  const d = new Date(utcIso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------------- validation

export type Validated<T, K extends string> = { ok: true; value: T } | { ok: false; errors: FieldErrors<K> };

function validateOptionalMacro(text: string, label: string): { value: number | null; error?: string } {
  if (text.trim() === '') return { value: null };
  const n = parseNumber(text);
  if (n === null || n < 0) return { value: null, error: `${label} must be a number, 0 or more.` };
  if (n > LIMITS.maxMacroG) return { value: null, error: `${label} looks too high (max ${LIMITS.maxMacroG} g).` };
  return { value: n };
}

function validateNotes(notes: string): string | undefined {
  return notes.length > LIMITS.maxNotesChars ? `Keep notes under ${LIMITS.maxNotesChars} characters.` : undefined;
}

export type MealFormInput = {
  carbs: string;
  label: string;
  fat: string;
  protein: string;
  fiber: string;
  absorption: AbsorptionClass | 'unset';
  timeApproximate: boolean;
  time: TimeChoice;
  notes: string;
};
export type MealField = 'carbs' | 'fat' | 'protein' | 'fiber' | 'time' | 'notes';

export type MealDraft = {
  occurredAtUtc: string;
  utcOffsetMin: number;
  label: string;
  carbsG: number;
  fatG: number | null;
  proteinG: number | null;
  fiberG: number | null;
  absorptionClass: AbsorptionClass | null;
  timeApproximate: boolean;
  notes: string | null;
};

export function validateMeal(input: MealFormInput, now: Date): Validated<MealDraft, MealField> {
  const errors: FieldErrors<MealField> = {};
  const carbs = parseNumber(input.carbs);
  if (input.carbs.trim() === '') errors.carbs = 'Enter the carbohydrates in grams.';
  else if (carbs === null || carbs <= 0) errors.carbs = 'Carbohydrates must be a number above 0.';
  else if (carbs > LIMITS.maxCarbsG) errors.carbs = `That is above ${LIMITS.maxCarbsG} g - check the number.`;

  const fat = validateOptionalMacro(input.fat, 'Fat');
  const protein = validateOptionalMacro(input.protein, 'Protein');
  const fiber = validateOptionalMacro(input.fiber, 'Fibre');
  if (fat.error) errors.fat = fat.error;
  if (protein.error) errors.protein = protein.error;
  if (fiber.error) errors.fiber = fiber.error;

  const time = resolveEventTime(input.time, now);
  if ('error' in time) errors.time = time.error;
  const notesError = validateNotes(input.notes);
  if (notesError) errors.notes = notesError;

  if (Object.keys(errors).length > 0 || carbs === null || 'error' in time) return { ok: false, errors };
  return {
    ok: true,
    value: {
      occurredAtUtc: time.utcIso,
      utcOffsetMin: time.utcOffsetMin,
      label: input.label.trim() || 'Meal (entered manually)',
      // One decimal, as the server requires.
      carbsG: Math.round(carbs * 10) / 10,
      fatG: fat.value,
      proteinG: protein.value,
      fiberG: fiber.value,
      absorptionClass: input.absorption === 'unset' ? null : input.absorption,
      timeApproximate: input.timeApproximate,
      notes: input.notes.trim() || null,
    },
  };
}

export type InsulinFormInput = {
  units: string;
  insulinKind: InsulinKind;
  /** `null` = the person has not chosen yet; nothing is assumed. */
  insulinType: InsulinType | null;
  /** The person's explicit statement that this dose was actually taken. */
  confirmedTaken: boolean;
  /** "I'm not sure of the amount or time." */
  notSure: boolean;
  time: TimeChoice;
  notes: string;
  mealId: string | null;
  glucose: string;
};
export type InsulinField = 'units' | 'insulinType' | 'confirmedTaken' | 'time' | 'notes' | 'glucose';

export type InsulinDraft = {
  occurredAtUtc: string;
  utcOffsetMin: number;
  insulinKind: InsulinKind;
  unitsAdministered: number;
  insulinType: InsulinType;
  confirmation: 'confirmed' | 'uncertain';
  timingUncertain: boolean;
  mealId: string | null;
  glucoseMgdl: number | null;
  notes: string | null;
};

export function validateInsulin(input: InsulinFormInput, now: Date): Validated<InsulinDraft, InsulinField> {
  const errors: FieldErrors<InsulinField> = {};
  const units = parseNumber(input.units);
  if (input.units.trim() === '') errors.units = 'Enter the units you took.';
  else if (units === null || units <= 0) errors.units = 'Units must be a number above 0.';
  else if (units > LIMITS.maxInsulinUnits) errors.units = `That is above ${LIMITS.maxInsulinUnits} units - check the number.`;
  else if (Math.abs(units * 100 - Math.round(units * 100)) > 1e-6) errors.units = 'Use at most 2 decimals.';
  if (input.insulinType === null) errors.insulinType = 'Choose the type of insulin.';
  if (!input.confirmedTaken) errors.confirmedTaken = 'Confirm that you actually took this insulin.';

  let glucose: number | null = null;
  if (input.glucose.trim() !== '') {
    const g = parseNumber(input.glucose);
    if (g === null || g < LIMITS.minGlucoseMgdl || g > LIMITS.maxGlucoseMgdl) {
      errors.glucose = `Glucose must be between ${LIMITS.minGlucoseMgdl} and ${LIMITS.maxGlucoseMgdl} mg/dL.`;
    } else {
      glucose = g;
    }
  }

  const time = resolveEventTime(input.time, now);
  if ('error' in time) errors.time = time.error;
  const notesError = validateNotes(input.notes);
  if (notesError) errors.notes = notesError;

  if (Object.keys(errors).length > 0 || units === null || input.insulinType === null || 'error' in time) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      occurredAtUtc: time.utcIso,
      utcOffsetMin: time.utcOffsetMin,
      insulinKind: input.insulinKind,
      unitsAdministered: units,
      insulinType: input.insulinType,
      confirmation: input.notSure ? 'uncertain' : 'confirmed',
      timingUncertain: input.notSure,
      // A meal link only makes sense for a meal dose.
      mealId: input.insulinKind === 'bolus' ? input.mealId : null,
      glucoseMgdl: input.insulinKind === 'correction' ? glucose : null,
      notes: input.notes.trim() || null,
    },
  };
}

// -------------------------------------------------------------------------------- construction

export function buildMealEvent(
  id: string,
  draft: MealDraft,
  provenance: { source: MealSource; aiCarbsG: number | null },
): MealEvent {
  return { kind: 'meal', id, ...draft, source: provenance.source, aiCarbsG: provenance.aiCarbsG };
}

export function buildInsulinEvent(id: string, draft: InsulinDraft): InsulinEvent {
  return { kind: 'insulin', id, ...draft };
}

/**
 * "I took no insulin for this meal": a confirmed 0 U meal bolus at the meal's time, linked to the
 * meal. This is the ONLY way to say "none taken"; an absent entry means "not logged".
 */
export function buildNoInsulinEvent(
  id: string,
  meal: { occurredAtUtc: string; utcOffsetMin: number; mealId: string | null },
  insulinType: InsulinType = 'rapid',
): InsulinEvent {
  return {
    kind: 'insulin',
    id,
    occurredAtUtc: meal.occurredAtUtc,
    utcOffsetMin: meal.utcOffsetMin,
    notes: null,
    insulinKind: 'bolus',
    unitsAdministered: 0,
    insulinType,
    confirmation: 'confirmed',
    timingUncertain: false,
    mealId: meal.mealId,
    glucoseMgdl: null,
  };
}

/** Pure, idempotent insert: an event whose id is already present changes nothing. Newest first. */
export function insertEvent(events: LoggedEvent[], event: LoggedEvent): LoggedEvent[] {
  if (events.some((e) => e.id === event.id)) return events;
  return [...events, event].sort((a, b) => Date.parse(b.occurredAtUtc) - Date.parse(a.occurredAtUtc));
}

/** Provenance of a photo meal: unchanged AI estimate vs the person's correction. */
export function photoMealSource(edited: boolean): MealSource {
  return edited ? 'gemini_edited' : 'gemini';
}

/** One-line, plain description of a logged event for lists. */
export function describeEvent(e: LoggedEvent): { title: string; detail: string } {
  if (e.kind === 'meal') {
    const src = e.source === 'manual' ? 'entered by you' : e.source === 'gemini_edited' ? 'AI estimate, corrected by you' : 'AI estimate';
    return { title: `${e.label} - ${Math.round(e.carbsG)} g carbs`, detail: src };
  }
  const type = INSULIN_TYPES.find((t) => t.value === e.insulinType)?.label ?? 'Insulin';
  const kind = INSULIN_KINDS.find((k) => k.value === e.insulinKind)?.label ?? 'Insulin';
  if (e.unitsAdministered === 0) return { title: 'No insulin taken (you confirmed)', detail: kind };
  const approx = e.confirmation === 'uncertain' ? ', approximate' : '';
  return { title: `Insulin - ${e.unitsAdministered} U taken`, detail: `${kind}, ${type}${approx}` };
}
