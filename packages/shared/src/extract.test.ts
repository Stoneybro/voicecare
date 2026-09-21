import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCareReport, splitClauses, applySelfCorrections, type ExtractOptions } from "./extract.ts";
import type { KnownExpression } from "./resolve.ts";

const options: ExtractOptions = {
  now: new Date("2026-09-19T09:30:00.000Z"),
  timeZone: "Europe/Lisbon",
  patientUnits: {},
};

test("extracts the full demo sentence", () => {
  const transcript =
    "I checked Mama this morning. Her pressure was one thirty-eight over eighty-eight, her sugar was six point two, temperature was thirty-seven point four, and her heart was beating at seventy-two. She ate about half her breakfast and said her left knee was hurting.";
  const result = extractCareReport(transcript, options);

  const byType = new Map(result.measurements.map((measurement) => [measurement.type, measurement]));
  assert.equal(result.measurements.length, 4);
  assert.deepEqual(
    { systolic: byType.get("blood_pressure")?.systolic, diastolic: byType.get("blood_pressure")?.diastolic },
    { systolic: 138, diastolic: 88 },
  );
  assert.equal(byType.get("blood_glucose")?.value, 6.2);
  assert.equal(byType.get("blood_glucose")?.unit, undefined);
  assert.equal(byType.get("temperature")?.value, 37.4);
  assert.equal(byType.get("heart_rate")?.value, 72);

  const pain = result.observations.find((observation) => observation.category === "pain");
  assert.equal(pain?.body_location, "left knee");
  assert.equal(pain?.negated, false);
  const food = result.observations.find((observation) => observation.category === "food_intake");
  assert.ok(food?.source_text.toLowerCase().includes("half her breakfast"));

  assert.equal(result.reportTime.source_text, "this morning");
  // The measurements carry no time of their own: they inherit the report default through
  // resolve.ts, which records time_status "report_default" (FR-027).
  assert.equal(
    result.measurements.every((measurement) => measurement.time_source_text === undefined),
    true,
  );
});

test("keeps negation and different observation times apart", () => {
  const result = extractCareReport("She had pain yesterday, but none today.", options);
  assert.equal(result.observations.length, 2);
  const [yesterday, today] = result.observations;
  assert.equal(yesterday.negated, false);
  assert.equal(today.negated, true);
  assert.equal(yesterday.time_source_text, "yesterday");
  assert.equal(today.time_source_text, "today");
  assert.notEqual(yesterday.observed_at, today.observed_at);
});

test("uses the corrected value when the caregiver corrects themselves", () => {
  const result = extractCareReport("Her heart was seventy—sorry, seventy-two this morning.", options);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0].value, 72);
  assert.ok(result.notes.some((note) => note.code === "self_correction"));
});

test("applies a remembered expression to a measurement", () => {
  const expressions: KnownExpression[] = [
    { id: "expr_engine", phrase: "engine", measurement_type: "heart_rate", unit: "bpm" },
  ];
  const result = extractCareReport("Her engine is 74 today.", { ...options, expressions });
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0].type, "heart_rate");
  assert.equal(result.measurements[0].value, 74);
  assert.equal(result.measurements[0].expression_id, "expr_engine");
});

test("a learned expression never turns a symptom into a measurement", () => {
  const expressions: KnownExpression[] = [
    { id: "expr_heart", phrase: "heart", measurement_type: "heart_rate", unit: "bpm" },
  ];
  const result = extractCareReport("Her heart hurts this afternoon.", { ...options, expressions });
  assert.equal(result.measurements.length, 0);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].category, "pain");
});

test("keeps an unsupported statement as free text instead of inventing a category", () => {
  const result = extractCareReport("She watched television for two hours this afternoon.", options);
  assert.equal(result.measurements.length, 0);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].category, "other");
  assert.equal(result.observations[0].time_source_text, "this afternoon");
});

test("labels an assumed observation time when nothing was stated", () => {
  const result = extractCareReport("Her sugar was 6.2.", options);
  assert.equal(result.reportTime.precision, "assumed");
  assert.equal(result.reportTime.status, "unknown");
  assert.ok(result.notes.some((note) => note.code === "time_assumed"));
});

test("clause splitting keeps number conjunctions intact", () => {
  assert.deepEqual(splitClauses("Her pressure was one hundred and thirty-eight over eighty, and she was calm."), [
    "Her pressure was one hundred and thirty-eight over eighty",
    "she was calm",
  ]);
});

test("self-correction replaces rather than duplicates a value", () => {
  assert.equal(applySelfCorrections("temperature was 37.2, not 37.4").text, "temperature was 37.2");
});
