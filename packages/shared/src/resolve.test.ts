import assert from "node:assert/strict";
import { test } from "node:test";
import { sequenceIdFactory } from "./ids.ts";
import { canonicalSnapshotString, deriveDraftStatus, resolveMeasurement, type ResolveContext } from "./resolve.ts";
import type { Measurement, MeasurementInput, Observation } from "./schemas.ts";

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    now: new Date("2026-09-19T09:30:00.000Z"),
    patientUnits: {},
    reportTime: {
      observed_at: "2026-09-19T07:00:00.000Z",
      precision: "morning",
      status: "relative_resolved",
      source_text: "this morning",
    },
    makeId: sequenceIdFactory(),
    ...overrides,
  };
}

function resolve(input: MeasurementInput, ctx: ResolveContext = context(), existing?: Measurement) {
  return resolveMeasurement(input, existing, ctx);
}

test("a glucose value without a unit stays unresolved and asks for the unit", () => {
  const { measurement, issues } = resolve({ type: "blood_glucose", value: 6.2, source_text: "sugar was six point two" });
  // 6.2 looks like mmol/L, but a plausible value is never evidence for a unit (spec/04 Unit policy).
  assert.equal(measurement.unit, null);
  assert.equal(measurement.unit_source, null);
  assert.equal(measurement.resolution_status, "needs_unit");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "needs_unit");
  assert.equal(issues[0].blocking, true);
  assert.deepEqual(issues[0].options, ["mmol/L", "mg/dL"]);
  assert.match(issues[0].question, /mmol\/L or mg\/dL/);
});

test("a configured patient unit resolves the value and is marked as configured", () => {
  const ctx = context({ patientUnits: { blood_glucose: "mmol/L" } });
  const { measurement, issues } = resolve({ type: "blood_glucose", value: 6.2, source_text: "sugar was 6.2" }, ctx);
  assert.equal(measurement.unit, "mmol/L");
  assert.equal(measurement.unit_source, "patient_setting");
  assert.equal(measurement.resolution_status, "resolved");
  assert.equal(issues.length, 0);
});

test("blood pressure keeps the spoken order and needs both numbers", () => {
  const { measurement } = resolve({
    type: "blood_pressure",
    systolic: 138,
    diastolic: 88,
    source_text: "pressure was one thirty-eight over eighty-eight",
  });
  assert.equal(measurement.systolic, 138);
  assert.equal(measurement.diastolic, 88);
  assert.equal(measurement.unit, "mmHg");
  assert.equal(measurement.resolution_status, "resolved");

  const incomplete = resolve({ type: "blood_pressure", systolic: 138, source_text: "pressure was 138" });
  assert.equal(incomplete.measurement.resolution_status, "needs_value");
  assert.equal(incomplete.issues[0].code, "needs_value");
  assert.match(incomplete.issues[0].question, /both numbers/);
});

test("an unsupported unit asks again instead of guessing", () => {
  const { measurement, issues } = resolve({
    type: "temperature",
    value: 37.4,
    unit: "kelvin",
    source_text: "temperature was 37.4 kelvin",
  });
  assert.equal(measurement.unit, null);
  assert.equal(measurement.resolution_status, "needs_unit");
  assert.match(issues[0].question, /not sure which unit/);
});

test("a missing time is recorded, never a blocking question", () => {
  const ctx = context({ reportTime: { observed_at: null, precision: "unknown", status: "unknown", source_text: null } });
  const { measurement, issues } = resolve({ type: "heart_rate", value: 80, source_text: "her heart was 80" }, ctx);
  assert.equal(measurement.unit, "bpm");
  assert.equal(measurement.resolution_status, "needs_time");
  assert.equal(issues[0].code, "needs_time");
  // Demo policy: the recording moment stands in for an unstated time, so the report stays
  // reviewable and the agent never interrogates the caregiver about when it happened.
  assert.equal(issues[0].blocking, false);
});

test("the report time is inherited and labelled as the report default", () => {
  const { measurement } = resolve({ type: "heart_rate", value: 72, source_text: "her heart was 72" });
  assert.equal(measurement.observed_at, "2026-09-19T07:00:00.000Z");
  assert.equal(measurement.time_status, "report_default");
  assert.equal(measurement.time_precision, "morning");
});

test("an unusual value is flagged but never replaced", () => {
  const { measurement } = resolve({ type: "temperature", value: 47, unit: "°C", source_text: "temperature was 47" });
  assert.equal(measurement.value, 47);
  assert.ok(measurement.warning);
});

test("an agent-flagged ambiguity blocks review until it is answered", () => {
  const { measurement, issues } = resolve({
    type: "heart_rate",
    value: 74,
    source_text: "her engine is 74",
    resolution_status: "ambiguous",
    clarification_question: "Do you mean her heart rate is 74 beats per minute?",
  });
  assert.equal(measurement.resolution_status, "ambiguous");
  assert.equal(issues[0].source, "agent");
  assert.match(issues[0].question, /heart rate/);
});

test("draft status follows the blocking issues", () => {
  const observation: Observation = {
    id: "o_1",
    category: "pain",
    text: "Pain in the left knee",
    body_location: "left knee",
    negated: false,
    observed_at: "2026-09-19T07:00:00.000Z",
    time_precision: "morning",
    time_source_text: "this morning",
    time_status: "relative_resolved",
    source_text: "her left knee was hurting",
    resolution_status: "resolved",
    ambiguity_note: null,
    clarification_question: null,
    warning: null,
  };
  assert.equal(
    deriveDraftStatus({ measurements: [], observations: [observation], transcript: "she was fine", issues: [] }),
    "REVIEWABLE",
  );
  const blocked = resolve({ type: "blood_glucose", value: 6.2, source_text: "sugar was 6.2" });
  assert.equal(
    deriveDraftStatus({
      measurements: [blocked.measurement],
      observations: [],
      transcript: "sugar was 6.2",
      issues: blocked.issues,
    }),
    "NEEDS_CLARIFICATION",
  );
  assert.equal(deriveDraftStatus({ measurements: [], observations: [], transcript: "", issues: [] }), "CAPTURING");
});

test("the canonical snapshot is stable for identical content", () => {
  const first = resolve({ type: "heart_rate", value: 72, source_text: "her heart was 72" });
  const snapshot = {
    revision: 1,
    status: "REVIEWABLE" as const,
    observation_time: "2026-09-19T07:00:00.000Z",
    observation_time_precision: "morning" as const,
    observation_time_source_text: "this morning",
    transcript: "her heart was 72",
    measurements: [first.measurement],
    observations: [],
    unresolved_issues: [],
  };
  const same = { ...snapshot, measurements: [{ ...first.measurement }] };
  const changed = { ...snapshot, measurements: [{ ...first.measurement, value: 74 }] };
  assert.equal(canonicalSnapshotString(snapshot), canonicalSnapshotString(same));
  assert.notEqual(canonicalSnapshotString(snapshot), canonicalSnapshotString(changed));
});

