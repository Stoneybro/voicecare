// Vocabularies and labels for the VoiceCare draft contract.
// This module is the single source of truth referenced by spec/05 ("Shared structured-data contract")
// and spec/03 FR-026: the agent tools, the backend validator, the browser, and the tests all use it.

export const MEASUREMENT_TYPES = [
  "blood_pressure",
  "blood_glucose",
  "temperature",
  "heart_rate",
  "oxygen_saturation",
] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

// Only blood pressure is reported in a single unit, so its unit never needs a clarification question.
export const BLOOD_PRESSURE_UNITS = ["mmHg"] as const;
export const BLOOD_GLUCOSE_UNITS = ["mmol/L", "mg/dL"] as const;
export const TEMPERATURE_UNITS = ["°C", "°F"] as const;
export const HEART_RATE_UNITS = ["bpm"] as const;
export const OXYGEN_SATURATION_UNITS = ["%"] as const;

export const MEASUREMENT_UNITS: Record<MeasurementType, readonly string[]> = {
  blood_pressure: BLOOD_PRESSURE_UNITS,
  blood_glucose: BLOOD_GLUCOSE_UNITS,
  temperature: TEMPERATURE_UNITS,
  heart_rate: HEART_RATE_UNITS,
  oxygen_saturation: OXYGEN_SATURATION_UNITS,
};

export const OBSERVATION_CATEGORIES = ["pain", "food_intake", "mood", "sleep", "symptom", "other"] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

export const TIME_STATUSES = ["explicit", "relative_resolved", "report_default", "unknown"] as const;
export type TimeStatus = (typeof TIME_STATUSES)[number];

export const TIME_PRECISIONS = ["exact", "morning", "afternoon", "evening", "day", "period", "assumed", "unknown"] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

export const RESOLUTION_STATUSES = ["resolved", "needs_unit", "needs_value", "needs_time", "ambiguous"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const UNIT_SOURCES = ["spoken", "patient_setting", "default"] as const;
export type UnitSource = (typeof UNIT_SOURCES)[number];

export const DRAFT_STATUSES = [
  "CAPTURING",
  "DRAFT",
  "NEEDS_CLARIFICATION",
  "REVIEWABLE",
  "CORRECTING",
  "CONFIRMED",
  "SAVED",
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const CONFIRMATION_METHODS = ["button", "voice"] as const;
export type ConfirmationMethod = (typeof CONFIRMATION_METHODS)[number];

// draft_revisions.reason (spec/05). "draft_created" is the revision-1 reason; the rest match the
// spec's list of draft-changing events.
export const DRAFT_REVISION_REASONS = [
  "draft_created",
  "agent_update",
  "clarification_answer",
  "caregiver_correction",
  "confirmation",
  "post_review_correction",
] as const;
export type DraftRevisionReason = (typeof DRAFT_REVISION_REASONS)[number];

// Ambiguity codes that resolve into a spoken/visible clarification (spec/04 "Material ambiguity rules").
export const ISSUE_CODES = [
  "needs_unit",
  "needs_value",
  "needs_time",
  "ambiguous",
  "expression_permission",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

// A permission question never blocks the report itself; it only blocks storing the vocabulary entry.
// needs_time never blocks either: the demo records at the recording moment, so an unstated time
// is captured as-is instead of interrogating the caregiver (spec/04 "Time policy"). Explicit
// past times in speech ("yesterday") are still preserved on the item; they just never gate saving.
export const BLOCKING_ISSUE_CODES: IssueCode[] = ["needs_unit", "needs_value", "ambiguous"];

export const CLARIFICATION_KINDS = [
  "unit",
  "value",
  "time",
  "expression",
  "subject",
  "confirmation",
  "generic",
] as const;
export type ClarificationKind = (typeof CLARIFICATION_KINDS)[number];

export const MEASUREMENT_LABELS: Record<MeasurementType, string> = {
  blood_pressure: "blood pressure",
  blood_glucose: "blood glucose",
  temperature: "temperature",
  heart_rate: "heart rate",
  oxygen_saturation: "oxygen saturation",
};

export const CATEGORY_LABELS: Record<ObservationCategory, string> = {
  pain: "pain",
  food_intake: "food and drink",
  mood: "mood",
  sleep: "sleep",
  symptom: "symptom",
  other: "observation",
};

// Readback speaks the unit, because a unit that came from a saved patient setting was not heard
// from the caregiver in this session (spec/04 "Unit policy").
export const UNIT_SPEECH: Record<string, string> = {
  mmHg: "millimetres of mercury",
  "mmol/L": "millimoles per litre",
  "mg/dL": "milligrams per decilitre",
  "°C": "degrees Celsius",
  "°F": "degrees Fahrenheit",
  bpm: "beats per minute",
  "%": "percent",
};

export const DEMO_SESSION_TTL_HOURS = 72;
export const PATIENT_UNIT_SETTING_SCOPE = "patient";
export const CAREGIVER_UNIT_SETTING_SCOPE = "caregiver";

export function isMeasurementType(value: unknown): value is MeasurementType {
  return typeof value === "string" && (MEASUREMENT_TYPES as readonly string[]).includes(value);
}

export function isUnitForType(type: MeasurementType, unit: string): boolean {
  return MEASUREMENT_UNITS[type].includes(unit);
}

export function unitsForType(type: MeasurementType): readonly string[] {
  return MEASUREMENT_UNITS[type];
}

export function isSingleUnitType(type: MeasurementType): boolean {
  return MEASUREMENT_UNITS[type].length === 1;
}

export function isBlockingIssueCode(code: IssueCode): boolean {
  return BLOCKING_ISSUE_CODES.includes(code);
}
