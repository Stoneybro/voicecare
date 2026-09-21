import assert from "node:assert/strict";
import { test } from "node:test";
import { sequenceIdFactory } from "./ids.ts";
import { buildReadback, describeObservationTime } from "./readback.ts";
import { deriveDraftStatus, resolveMeasurement, resolveObservation, type ResolveContext } from "./resolve.ts";
import type { DraftSnapshot } from "./schemas.ts";

function context(patientUnits: ResolveContext["patientUnits"] = { blood_glucose: "mmol/L" }): ResolveContext {
  return {
    now: new Date("2026-09-19T09:30:00.000Z"),
    patientUnits,
    reportTime: {
      observed_at: "2026-09-19T07:00:00.000Z",
      precision: "morning",
      status: "relative_resolved",
      source_text: "this morning",
    },
    makeId: sequenceIdFactory(),
  };
}

function snapshotFrom(
  ctx: ResolveContext,
  inputs: Parameters<typeof resolveMeasurement>[0][],
  observations: Parameters<typeof resolveObservation>[0][] = [],
): DraftSnapshot {
  const measurementResults = inputs.map((input) => resolveMeasurement(input, undefined, ctx));
  const observationResults = observations.map((input) => resolveObservation(input, undefined, ctx));
  const issues = [...measurementResults.flatMap((result) => result.issues), ...observationResults.flatMap((result) => result.issues)];
  const measurements = measurementResults.map((result) => result.measurement);
  const resolvedObservations = observationResults.map((result) => result.observation);
  return {
    revision: 1,
    status: deriveDraftStatus({ measurements, observations: resolvedObservations, transcript: "demo", issues }),
    observation_time: ctx.reportTime.observed_at,
    observation_time_precision: ctx.reportTime.precision,
    observation_time_source_text: ctx.reportTime.source_text,
    transcript: "demo",
    measurements,
    observations: resolvedObservations,
    unresolved_issues: issues,
  };
}

test("readback speaks every value with its unit", () => {
  const ctx = context();
  const snapshot = snapshotFrom(
    ctx,
    [
      { type: "blood_pressure", systolic: 138, diastolic: 88, source_text: "pressure was 138 over 88" },
      { type: "blood_glucose", value: 6.2, source_text: "sugar was 6.2" },
      { type: "temperature", value: 37.4, unit: "°C", source_text: "temperature was 37.4" },
    ],
    [{ category: "pain", text: "Pain in the left knee", body_location: "left knee", source_text: "her left knee was hurting" }],
  );
  const readback = buildReadback(snapshot, { patientName: "Rosa", timeZone: "Europe/Lisbon" });
  assert.match(readback, /138 over 88 millimetres of mercury/);
  assert.match(readback, /blood glucose 6\.2 millimoles per litre, from your saved setting/);
  assert.match(readback, /temperature 37\.4 degrees Celsius/);
  assert.match(readback, /pain in the left knee/);
  assert.match(readback, /The time was this morning\./);
  assert.match(readback, /Is that correct\?$/);
  assert.equal(snapshot.status, "REVIEWABLE");
});

test("readback states what still blocks saving", () => {
  const ctx = context({});
  const snapshot = snapshotFrom(ctx, [{ type: "blood_glucose", value: 6.2, source_text: "sugar was 6.2" }]);
  const readback = buildReadback(snapshot, { patientName: "Rosa", timeZone: "Europe/Lisbon" });
  assert.equal(snapshot.status, "NEEDS_CLARIFICATION");
  assert.match(readback, /I still need to check something before this report can be saved/);
  assert.match(readback, /mmol\/L or mg\/dL/);
});

test("an assumed observation time is announced as assumed", () => {
  assert.equal(
    describeObservationTime({ observation_time: "2026-09-19T09:30:00.000Z", observation_time_precision: "assumed", observation_time_source_text: null }),
    "I used the time you sent this in as the observation time.",
  );
});
