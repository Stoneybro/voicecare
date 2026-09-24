// Deterministic export tests: same reports in, same text out, disclaimer everywhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDoctorText, buildFamilyText, buildReportsCSV, buildReportsJSON, EXPORT_DISCLAIMER } from "./exports.ts";
import type { ReportRecord } from "./schemas.ts";

function fakeReport(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: "rep_0001",
    draft_id: "draft_0001",
    confirmed_revision: 1,
    confirmation_method: "button",
    confirmed_at: new Date("2026-09-20T10:00:00Z").toISOString(),
    patient_id: "pat_0001",
    patient_name: "Rosa",
    caregiver_name: "Demo caregiver",
    observation_time: new Date("2026-09-20T08:00:00Z").toISOString(),
    observation_time_precision: "exact",
    observation_time_source_text: "this morning",
    entry_time: new Date("2026-09-20T10:00:00Z").toISOString(),
    saved_at: new Date("2026-09-20T10:00:00Z").toISOString(),
    original_transcript: "pressure 138 over 88, left knee hurting",
    measurements: [
      {
        id: "m1",
        type: "blood_pressure",
        systolic: 138,
        diastolic: 88,
        value: null,
        unit: "mmHg",
        unit_source: "spoken",
        observed_at: new Date("2026-09-20T08:00:00Z").toISOString(),
        time_precision: "exact",
        time_source_text: "this morning",
        time_status: "relative_resolved",
        source_text: "pressure 138 over 88",
        resolution_status: "resolved",
        ambiguity_note: null,
        clarification_question: null,
        warning: null,
        expression_id: null,
        expression_phrase: null,
      },
    ],
    observations: [
      {
        id: "o1",
        category: "pain",
        text: "Left knee pain",
        body_location: "left knee",
        negated: false,
        observed_at: new Date("2026-09-20T08:00:00Z").toISOString(),
        time_precision: "exact",
        time_source_text: "this morning",
        time_status: "relative_resolved",
        source_text: "left knee hurting",
        resolution_status: "resolved",
        ambiguity_note: null,
        clarification_question: null,
        warning: null,
      },
    ],
    superseded_by_report_id: null,
    supersedes_report_id: null,
    ...overrides,
  };
}

describe("exports", () => {
  it("doctor text carries vitals, symptoms, own words, and disclaimer", () => {
    const text = buildDoctorText([fakeReport()], "Rosa");
    assert.match(text, /blood pressure/);
    assert.match(text, /138 \/ 88/);
    assert.match(text, /Left knee pain/);
    assert.match(text, /own words/);
    assert.ok(text.includes(EXPORT_DISCLAIMER));
  });

  it("family text is plain language with disclaimer", () => {
    const text = buildFamilyText([fakeReport()], "Rosa");
    assert.match(text, /blood pressure was 138 \/ 88/);
    assert.ok(text.includes(EXPORT_DISCLAIMER));
  });

  it("csv has one row per item plus header", () => {
    const csv = buildReportsCSV([fakeReport()]);
    const rows = csv.split("\n");
    assert.equal(rows[0], "report_id,patient,observation_time,entry_time,kind,type,value,unit,negated,source_text");
    assert.equal(rows.length, 3);
  });

  it("json parses and carries the disclaimer", () => {
    const parsed = JSON.parse(buildReportsJSON([fakeReport()])) as { disclaimer: string; reports: unknown[] };
    assert.equal(parsed.disclaimer, EXPORT_DISCLAIMER);
    assert.equal(parsed.reports.length, 1);
  });
});
