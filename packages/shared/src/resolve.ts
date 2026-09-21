// Normalization, validation, and issue derivation for draft items (spec/03 FR-020 - FR-036).
//
// This module is the only place that decides whether a measurement or observation is complete.
// The voice agent may propose an interpretation; these rules decide whether it is eligible for
// confirmation, and a missing unit is never filled from a plausible-looking value (spec/04
// "Unit policy").

import { ID_PREFIXES, type IdFactory } from "./ids.ts";
import {
  ambiguityQuestion,
  timeQuestion,
  unitQuestion,
  unsupportedUnitQuestion,
  valueQuestion,
} from "./questions.ts";
import type {
  DraftIssue,
  DraftSnapshot,
  Measurement,
  MeasurementInput,
  Observation,
  ObservationInput,
} from "./schemas.ts";
import {
  MEASUREMENT_LABELS,
  isBlockingIssueCode,
  isSingleUnitType,
  isUnitForType,
  unitsForType,
  type MeasurementType,
  type ResolutionStatus,
  type TimePrecision,
  type TimeStatus,
  type UnitSource,
  type DraftStatus,
} from "./vocab.ts";

export type ReportTime = {
  observed_at: string | null;
  precision: TimePrecision;
  status: TimeStatus;
  source_text: string | null;
};

export type KnownExpression = {
  id: string;
  phrase: string;
  measurement_type: MeasurementType;
  unit: string | null;
};

export type ResolveContext = {
  now: Date;
  patientUnits: Partial<Record<MeasurementType, string>>;
  reportTime: ReportTime;
  makeId: IdFactory;
  expressions?: KnownExpression[];
};

// Advisory ranges only: an unusual value is flagged for the caregiver, never replaced
// (spec/05 "Validation may flag unusual values but must not silently replace them").
const PLAUSIBLE_RANGES: Record<string, { min: number; max: number }> = {
  blood_pressure_systolic: { min: 70, max: 250 },
  blood_pressure_diastolic: { min: 40, max: 150 },
  "blood_glucose:mmol/L": { min: 1.5, max: 33.3 },
  "blood_glucose:mg/dL": { min: 27, max: 600 },
  "temperature:°C": { min: 30, max: 43 },
  "temperature:°F": { min: 86, max: 109 },
  "heart_rate:bpm": { min: 25, max: 220 },
  "oxygen_saturation:%": { min: 50, max: 100 },
};

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function makeIssue(input: {
  ctx: ResolveContext;
  code: DraftIssue["code"];
  target: DraftIssue["target"];
  targetId: string | null;
  question: string;
  options?: string[];
  source?: DraftIssue["source"];
  phrase?: string | null;
  measurementType?: MeasurementType | null;
  unit?: string | null;
  patientSpecific?: boolean | null;
}): DraftIssue {
  return {
    id: input.ctx.makeId(ID_PREFIXES.issue),
    code: input.code,
    target: input.target,
    target_id: input.targetId,
    question: input.question,
    options: input.options ?? [],
    blocking: isBlockingIssueCode(input.code),
    source: input.source ?? "backend",
    created_at: input.ctx.now.toISOString(),
    phrase: input.phrase ?? null,
    measurement_type: input.measurementType ?? null,
    unit: input.unit ?? null,
    patient_specific: input.patientSpecific ?? null,
  };
}

type TimeFields = {
  observed_at: string | null;
  time_precision: TimePrecision;
  time_source_text: string | null;
  time_status: TimeStatus;
};

function inheritTime(
  provided: { observed_at?: string | null; time_precision?: TimePrecision; time_source_text?: string | null; time_status?: TimeStatus },
  existing: TimeFields | undefined,
  ctx: ResolveContext,
): TimeFields {
  if (provided.observed_at !== undefined && provided.observed_at !== null) {
    return {
      observed_at: provided.observed_at,
      time_precision: provided.time_precision ?? existing?.time_precision ?? "exact",
      time_source_text:
        provided.time_source_text !== undefined ? provided.time_source_text : (existing?.time_source_text ?? null),
      time_status: provided.time_status ?? "explicit",
    };
  }
  if (provided.observed_at === undefined && existing?.observed_at) {
    return {
      observed_at: existing.observed_at,
      time_precision: provided.time_precision ?? existing.time_precision,
      time_source_text: provided.time_source_text === undefined ? existing.time_source_text : provided.time_source_text,
      time_status: provided.time_status ?? existing.time_status,
    };
  }
  if (ctx.reportTime.observed_at) {
    return {
      observed_at: ctx.reportTime.observed_at,
      time_precision: ctx.reportTime.precision,
      time_source_text: ctx.reportTime.source_text,
      time_status: "report_default",
    };
  }
  return { observed_at: null, time_precision: "unknown", time_source_text: null, time_status: "unknown" };
}

function rangeWarning(item: {
  type: MeasurementType;
  systolic: number | null;
  diastolic: number | null;
  value: number | null;
  unit: string | null;
}): string | null {
  const checks: Array<{ label: string; value: number | null; range: { min: number; max: number } | undefined }> = [];
  if (item.type === "blood_pressure") {
    checks.push({ label: "systolic", value: item.systolic, range: PLAUSIBLE_RANGES.blood_pressure_systolic });
    checks.push({ label: "diastolic", value: item.diastolic, range: PLAUSIBLE_RANGES.blood_pressure_diastolic });
  } else {
    checks.push({ label: "value", value: item.value, range: item.unit ? PLAUSIBLE_RANGES[`${item.type}:${item.unit}`] : undefined });
  }
  for (const check of checks) {
    if (check.value === null || !check.range) continue;
    if (check.value < check.range.min || check.value > check.range.max) {
      return `The ${check.label} for the ${MEASUREMENT_LABELS[item.type]} looks unusual. I kept the number you said, but please double-check it.`;
    }
  }
  return null;
}

export function formatValueText(type: MeasurementType, item: { systolic: number | null; diastolic: number | null; value: number | null }): string {
  if (type === "blood_pressure") {
    return `${item.systolic ?? "?"} over ${item.diastolic ?? "?"}`;
  }
  return item.value === null ? "?" : String(item.value);
}

export function resolveMeasurement(
  input: MeasurementInput,
  existing: Measurement | undefined,
  ctx: ResolveContext,
): { measurement: Measurement; issues: DraftIssue[] } {
  const issues: DraftIssue[] = [];
  const type = input.type;
  const isBloodPressure = type === "blood_pressure";
  const id = input.id ?? existing?.id ?? ctx.makeId(ID_PREFIXES.measurement);
  const systolic = isBloodPressure ? numeric(input.systolic ?? existing?.systolic ?? null) : null;
  const diastolic = isBloodPressure ? numeric(input.diastolic ?? existing?.diastolic ?? null) : null;
  const value = isBloodPressure ? null : numeric(input.value ?? existing?.value ?? null);
  const sourceText = text(input.source_text ?? existing?.source_text ?? "") || text(input.source_text);
  const expressionId = input.expression_id ?? existing?.expression_id ?? null;
  const expression = expressionId && ctx.expressions ? (ctx.expressions.find((item) => item.id === expressionId) ?? null) : null;

  let resolution: ResolutionStatus = "resolved";
  const hasValue = isBloodPressure ? systolic !== null && diastolic !== null : value !== null;
  if (!hasValue) {
    resolution = "needs_value";
    issues.push(
      makeIssue({
        ctx,
        code: "needs_value",
        target: "measurement",
        targetId: id,
        question: valueQuestion(type),
      }),
    );
  }

  // Unit policy: speech first, then a configured patient unit, then the single unit a type can have.
  // A plausible-looking value is never used as evidence for a unit.
  let unit: string | null = null;
  let unitSource: UnitSource | null = null;
  let unsupportedUnit = false;
  if (input.unit !== undefined && text(input.unit).length > 0) {
    const proposed = text(input.unit);
    if (isUnitForType(type, proposed)) {
      unit = proposed;
      unitSource = "spoken";
    } else {
      unsupportedUnit = true;
      // One compact question at a time (FR-031): the value question comes first when both are open.
      if (hasValue) {
        issues.push(
          makeIssue({
            ctx,
            code: "needs_unit",
            target: "measurement",
            targetId: id,
            question: unsupportedUnitQuestion(type, proposed),
            options: [...unitsForType(type)],
          }),
        );
      }
    }
  }
  if (unit === null && input.unit === undefined && existing?.unit && isUnitForType(type, existing.unit)) {
    unit = existing.unit;
    unitSource = existing.unit_source ?? "spoken";
  }
  if (unit === null) {
    const configured = ctx.patientUnits[type];
    if (configured && isUnitForType(type, configured)) {
      unit = configured;
      unitSource = "patient_setting";
    } else if (isSingleUnitType(type)) {
      unit = unitsForType(type)[0];
      unitSource = "default";
    }
  }
  if (unit === null && resolution === "resolved") {
    resolution = "needs_unit";
    issues.push(
      makeIssue({
        ctx,
        code: "needs_unit",
        target: "measurement",
        targetId: id,
        question: unitQuestion(type, formatValueText(type, { systolic, diastolic, value })),
        options: [...unitsForType(type)],
      }),
    );
  }
  if (unsupportedUnit && resolution === "resolved") {
    resolution = "needs_unit";
  }

  const time = inheritTime(
    {
      observed_at: input.observed_at ?? (input.observed_at === null ? null : undefined),
      time_precision: input.time_precision,
      time_source_text: input.time_source_text,
      time_status: input.time_status,
    },
    existing,
    ctx,
  );
  if (time.observed_at === null && resolution === "resolved") {
    resolution = "needs_time";
    issues.push(
      makeIssue({
        ctx,
        code: "needs_time",
        target: "measurement",
        targetId: id,
        question: timeQuestion(MEASUREMENT_LABELS[type]),
      }),
    );
  }

  const warning = rangeWarning({ type, systolic, diastolic, value, unit });

  if (input.resolution_status === "ambiguous" && resolution === "resolved") {
    resolution = "ambiguous";
    issues.push(
      makeIssue({
        ctx,
        code: "ambiguous",
        target: "measurement",
        targetId: id,
        question: text(input.clarification_question) || ambiguityQuestion(sourceText),
        source: "agent",
      }),
    );
  }

  const measurement: Measurement = {
    id,
    type,
    systolic,
    diastolic,
    value,
    unit,
    unit_source: unitSource,
    observed_at: time.observed_at,
    time_precision: time.time_precision,
    time_source_text: time.time_source_text,
    time_status: time.time_status,
    source_text: sourceText,
    resolution_status: resolution,
    ambiguity_note: text(input.ambiguity_note ?? existing?.ambiguity_note ?? "") || null,
    clarification_question: text(input.clarification_question ?? existing?.clarification_question ?? "") || null,
    warning,
    expression_id: expression?.id ?? expressionId,
    expression_phrase: expression?.phrase ?? existing?.expression_phrase ?? null,
  };
  return { measurement, issues };
}

export function resolveObservation(
  input: ObservationInput,
  existing: Observation | undefined,
  ctx: ResolveContext,
): { observation: Observation; issues: DraftIssue[] } {
  const issues: DraftIssue[] = [];
  const id = input.id ?? existing?.id ?? ctx.makeId(ID_PREFIXES.observation);
  const category = input.category;
  const textValue = text(input.text ?? existing?.text ?? "");
  const bodyLocation = text(input.body_location ?? existing?.body_location ?? "") || null;
  const negated = input.negated ?? existing?.negated ?? false;
  const sourceText = text(input.source_text ?? existing?.source_text ?? "");

  const time = inheritTime(
    {
      observed_at: input.observed_at === null ? null : input.observed_at,
      time_precision: input.time_precision,
      time_source_text: input.time_source_text,
      time_status: input.time_status,
    },
    existing,
    ctx,
  );

  let resolution: ResolutionStatus = "resolved";
  if (time.observed_at === null) {
    resolution = "needs_time";
    issues.push(
      makeIssue({
        ctx,
        code: "needs_time",
        target: "observation",
        targetId: id,
        question: timeQuestion(textValue || "observation"),
      }),
    );
  }
  if (input.resolution_status === "ambiguous" && resolution === "resolved") {
    resolution = "ambiguous";
    issues.push(
      makeIssue({
        ctx,
        code: "ambiguous",
        target: "observation",
        targetId: id,
        question: text(input.clarification_question) || ambiguityQuestion(sourceText || textValue),
        source: "agent",
      }),
    );
  }

  const observation: Observation = {
    id,
    category,
    text: textValue,
    body_location: bodyLocation,
    negated,
    observed_at: time.observed_at,
    time_precision: time.time_precision,
    time_source_text: time.time_source_text,
    time_status: time.time_status,
    source_text: sourceText,
    resolution_status: resolution,
    ambiguity_note: text(input.ambiguity_note ?? existing?.ambiguity_note ?? "") || null,
    clarification_question: text(input.clarification_question ?? existing?.clarification_question ?? "") || null,
    warning: null,
  };
  return { observation, issues };
}

export function makeExpressionPermissionIssue(
  input: { phrase: string; measurementType: MeasurementType; unit: string | null; patientSpecific: boolean; question: string },
  ctx: ResolveContext,
): DraftIssue {
  return makeIssue({
    ctx,
    code: "expression_permission",
    target: "report",
    targetId: null,
    question: input.question,
    source: "agent",
    phrase: input.phrase,
    measurementType: input.measurementType,
    unit: input.unit,
    patientSpecific: input.patientSpecific,
  });
}

export function issuesFromResolvedItems(input: {
  measurements: Measurement[];
  observations: Observation[];
  now: Date;
  makeId: IdFactory;
}): DraftIssue[] {
  const ctx: ResolveContext = {
    now: input.now,
    patientUnits: {},
    reportTime: { observed_at: null, precision: "unknown", status: "unknown", source_text: null },
    makeId: input.makeId,
  };
  const issues: DraftIssue[] = [];
  for (const measurement of input.measurements) {
    const label = MEASUREMENT_LABELS[measurement.type];
    const valueText = formatValueText(measurement.type, measurement);
    if (measurement.resolution_status === "needs_value") {
      issues.push(
        makeIssue({ ctx, code: "needs_value", target: "measurement", targetId: measurement.id, question: valueQuestion(measurement.type) }),
      );
    } else if (measurement.resolution_status === "needs_unit") {
      issues.push(
        makeIssue({
          ctx,
          code: "needs_unit",
          target: "measurement",
          targetId: measurement.id,
          question: unitQuestion(measurement.type, valueText),
          options: [...unitsForType(measurement.type)],
        }),
      );
    } else if (measurement.resolution_status === "needs_time") {
      issues.push(
        makeIssue({ ctx, code: "needs_time", target: "measurement", targetId: measurement.id, question: timeQuestion(label) }),
      );
    } else if (measurement.resolution_status === "ambiguous") {
      issues.push(
        makeIssue({
          ctx,
          code: "ambiguous",
          target: "measurement",
          targetId: measurement.id,
          question: measurement.clarification_question ?? ambiguityQuestion(measurement.source_text),
          source: "agent",
        }),
      );
    }
  }
  for (const observation of input.observations) {
    if (observation.resolution_status === "needs_time") {
      issues.push(
        makeIssue({
          ctx,
          code: "needs_time",
          target: "observation",
          targetId: observation.id,
          question: timeQuestion(observation.text || "observation"),
        }),
      );
    } else if (observation.resolution_status === "ambiguous") {
      issues.push(
        makeIssue({
          ctx,
          code: "ambiguous",
          target: "observation",
          targetId: observation.id,
          question: observation.clarification_question ?? ambiguityQuestion(observation.source_text || observation.text),
          source: "agent",
        }),
      );
    }
  }
  return issues;
}

export function deriveDraftStatus(input: {
  measurements: Measurement[];
  observations: Observation[];
  transcript: string;
  issues: DraftIssue[];
}): DraftStatus {
  const hasContent =
    input.measurements.length > 0 || input.observations.length > 0 || input.transcript.trim().length > 0;
  if (!hasContent) return "CAPTURING";
  return input.issues.some((issue) => issue.blocking) ? "NEEDS_CLARIFICATION" : "REVIEWABLE";
}

export function isReviewable(snapshot: { status: DraftStatus }): boolean {
  return snapshot.status === "REVIEWABLE" || snapshot.status === "CONFIRMED" || snapshot.status === "SAVED";
}

// Deterministic serialization. The report content hash is computed from this string, so a repeated
// save with the same content produces the same hash and can be recognized as a retry (FR-044/FR-046).
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

export function canonicalSnapshotString(snapshot: DraftSnapshot): string {
  return stableStringify({
    observation_time: snapshot.observation_time,
    observation_time_precision: snapshot.observation_time_precision,
    observation_time_source_text: snapshot.observation_time_source_text,
    transcript: snapshot.transcript,
    measurements: snapshot.measurements,
    observations: snapshot.observations,
  });
}


