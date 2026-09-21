// Confirmed-report reads: session-scoped history and the printable summary (spec/05
// "Save and amendment flow", FR-060 - FR-064, spec/02 "History and summary flow").
//
// History lists current reports only, so one observation appears exactly once. A report that
// was superseded by a later confirmed revision of the same draft stays in the database as the
// audit trail and is reachable from the current report, never from the default history list.

import { z } from "zod";
import {
  measurementSchema,
  observationSchema,
  type ReportRecord,
  type TimePrecision,
} from "@voicecare/shared";
import { getSql } from "./db";
import { ApiError } from "./http";
import type { DemoSession } from "./session";

export type ReportRow = {
  id: string;
  draft_id: string;
  confirmed_revision: number;
  confirmation_method: string;
  confirmed_at: string;
  patient_id: string;
  patient_name: string;
  caregiver_name: string;
  observation_time: string | null;
  observation_time_precision: string | null;
  observation_time_source: string | null;
  entry_time: string;
  saved_at: string;
  original_transcript: string;
  measurements: unknown;
  observations: unknown;
  current_report_id: string | null;
};

const measurementListSchema = z.array(measurementSchema);
const observationListSchema = z.array(observationSchema);

function isoOrNull(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function recordFromRow(row: ReportRow, siblings: ReportRow[]): ReportRecord {
  const measurements = measurementListSchema.safeParse(row.measurements ?? []);
  if (!measurements.success) {
    console.error("[voicecare] could not read report measurements", row.id, measurements.error.issues);
    throw new ApiError(500, "report_unreadable", "A saved report could not be read. Reset the demo to continue.");
  }
  const observations = observationListSchema.safeParse(row.observations ?? []);
  if (!observations.success) {
    console.error("[voicecare] could not read report observations", row.id, observations.error.issues);
    throw new ApiError(500, "report_unreadable", "A saved report could not be read. Reset the demo to continue.");
  }

  // The draft's revision chain, ordered oldest first: earlier confirmed revisions are the
  // reports this one supersedes, and a later current report is the one that supersedes it.
  const ordered = [...siblings].sort((a, b) => a.confirmed_revision - b.confirmed_revision);
  const index = ordered.findIndex((candidate) => candidate.id === row.id);
  const supersedes = index > 0 ? ordered[index - 1]!.id : null;
  const supersededBy =
    row.current_report_id && row.current_report_id !== row.id ? row.current_report_id : null;

  return {
    id: row.id,
    draft_id: row.draft_id,
    confirmed_revision: row.confirmed_revision,
    confirmation_method: row.confirmation_method === "voice" ? "voice" : "button",
    confirmed_at: new Date(row.confirmed_at).toISOString(),
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    caregiver_name: row.caregiver_name,
    observation_time: isoOrNull(row.observation_time),
    observation_time_precision: (row.observation_time_precision ?? "unknown") as TimePrecision,
    observation_time_source_text: row.observation_time_source,
    entry_time: new Date(row.entry_time).toISOString(),
    saved_at: new Date(row.saved_at).toISOString(),
    original_transcript: row.original_transcript,
    measurements: measurements.data,
    observations: observations.data,
    superseded_by_report_id: supersededBy,
    supersedes_report_id: supersedes,
  };
}

// Current reports only: one observation appears exactly once (spec/05).
// Superseded revisions are excluded by default and reachable through the report detail.
export async function listCurrentReports(
  session: DemoSession,
  patientId: string,
  range: { from: string | null; to: string | null },
): Promise<ReportRecord[]> {
  const sql = getSql();
  const rows = (await sql`
    select r.id, r.draft_id, r.confirmed_revision, r.confirmation_method, r.confirmed_at,
      r.patient_id, p.display_name as patient_name, c.display_name as caregiver_name,
      r.observation_time, r.observation_time_precision, r.observation_time_source,
      r.entry_time, r.saved_at, r.original_transcript, r.measurements, r.observations,
      d.current_report_id
    from reports r
    join patients p on p.id = r.patient_id
    join caregivers c on c.id = r.caregiver_id
    join drafts d on d.id = r.draft_id
    where r.caregiver_id = ${session.caregiverId}
      and r.patient_id = ${patientId}
      and d.current_report_id = r.id
      and (${range.from}::timestamptz is null or coalesce(r.observation_time, r.entry_time) >= ${range.from}::timestamptz)
      and (${range.to}::timestamptz is null or coalesce(r.observation_time, r.entry_time) <= ${range.to}::timestamptz)
    order by r.observation_time desc nulls last, r.saved_at desc
  `) as ReportRow[];
  return rows.map((row) => recordFromRow(row, rows));
}

// The printable appointment summary reads the same current reports in chronological order,
// with the caregiver-reported disclaimer rendered by the client (FR-064).
export async function listSummaryReports(
  session: DemoSession,
  patientId: string,
  range: { from: string | null; to: string | null },
): Promise<ReportRecord[]> {
  return (await listCurrentReports(session, patientId, range)).reverse();
}

export async function getReport(session: DemoSession, reportId: string): Promise<ReportRecord> {
  const sql = getSql();
  const rows = (await sql`
    select r.id, r.draft_id, r.confirmed_revision, r.confirmation_method, r.confirmed_at,
      r.patient_id, p.display_name as patient_name, c.display_name as caregiver_name,
      r.observation_time, r.observation_time_precision, r.observation_time_source,
      r.entry_time, r.saved_at, r.original_transcript, r.measurements, r.observations,
      d.current_report_id
    from reports r
    join patients p on p.id = r.patient_id
    join caregivers c on c.id = r.caregiver_id
    join drafts d on d.id = r.draft_id
    where r.id = ${reportId} and r.caregiver_id = ${session.caregiverId}
    limit 1
  `) as ReportRow[];
  const row = rows[0];
  if (!row) {
    throw new ApiError(404, "report_not_found", "That report is not part of this demo session.");
  }
  const siblings = (await sql`
    select r.id, r.draft_id, r.confirmed_revision, r.confirmation_method, r.confirmed_at,
      r.patient_id, p.display_name as patient_name, c.display_name as caregiver_name,
      r.observation_time, r.observation_time_precision, r.observation_time_source,
      r.entry_time, r.saved_at, r.original_transcript, r.measurements, r.observations,
      d.current_report_id
    from reports r
    join patients p on p.id = r.patient_id
    join caregivers c on c.id = r.caregiver_id
    join drafts d on d.id = r.draft_id
    where r.draft_id = ${row.draft_id} and r.caregiver_id = ${session.caregiverId}
    order by r.confirmed_revision asc
  `) as ReportRow[];
  return recordFromRow(row, siblings);
}

export async function countReports(caregiverId: string): Promise<number> {
  const rows = (await getSql()`
    select count(*)::int as count from reports where caregiver_id = ${caregiverId}
  `) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}
