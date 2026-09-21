// Draft lifecycle: the structured draft, its revision trail, confirmation, and the idempotent save
// (spec/05 "Save and amendment flow", spec/06 "Confirmation safeguards").
//
// Only this module writes draft rows. Every draft-changing request carries the revision it expects,
// and a mismatch changes nothing and returns the latest draft (FR-036).

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  buildReadback,
  canonicalSnapshotString,
  clarificationSchema,
  deriveDraftStatus,
  draftIssueSchema,
  ID_PREFIXES,
  issuesFromResolvedItems,
  measurementSchema,
  observationSchema,
  precisionForSourceText,
  resolveMeasurement,
  resolveObservation,
  unresolvedStatement,
  type Clarification,
  type ConfirmationMethod,
  type DraftIssue,
  type DraftPatch,
  type DraftRecord,
  type DraftRevisionReason,
  type DraftSnapshot,
  type DraftStatus,
  type KnownExpression,
  type Measurement,
  type MeasurementInput,
  type Observation,
  type ObservationInput,
  type ReportTime,
  type ResolveContext,
  type TimePrecision,
  type TimeStatus,
} from "@voicecare/shared";
import { getSql } from "./db";
import { ApiError } from "./http";
import { newId, type DemoSession, type PatientSummary } from "./session";

export type DraftRow = {
  id: string;
  patient_id: string;
  patient_name: string;
  caregiver_id: string;
  session_id: string | null;
  revision: number;
  status: string;
  original_transcript: string;
  observation_time: string | null;
  observation_time_precision: string | null;
  observation_time_source: string | null;
  entry_time: string;
  measurements: unknown;
  observations: unknown;
  unresolved_issues: unknown;
  clarification_log: unknown;
  confirmed_revision: number | null;
  confirmation_method: string | null;
  confirmed_at: string | null;
  current_report_id: string | null;
  created_at: string;
  updated_at: string;
};

const measurementListSchema = z.array(measurementSchema);
const observationListSchema = z.array(observationSchema);
const issueListSchema = z.array(draftIssueSchema);
const clarificationListSchema = z.array(clarificationSchema);

function parseColumn<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value ?? []);
  if (result.success) return result.data;
  console.error(`[voicecare] could not read ${label}`, result.error.issues);
  throw new ApiError(500, "draft_unreadable", "This draft could not be read. Reset the demo to continue.");
}

function isoOrNull(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function snapshotFromRow(row: DraftRow): DraftSnapshot {
  return {
    revision: row.revision,
    status: row.status as DraftStatus,
    observation_time: isoOrNull(row.observation_time),
    observation_time_precision: (row.observation_time_precision ?? "unknown") as TimePrecision,
    observation_time_source_text: row.observation_time_source,
    transcript: row.original_transcript,
    measurements: parseColumn(measurementListSchema, row.measurements, "measurements"),
    observations: parseColumn(observationListSchema, row.observations, "observations"),
    unresolved_issues: parseColumn(issueListSchema, row.unresolved_issues, "unresolved_issues"),
  };
}

export function recordFromRow(row: DraftRow, timezone: string): DraftRecord {
  const snapshot = snapshotFromRow(row);
  return {
    ...snapshot,
    id: row.id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    caregiver_id: row.caregiver_id,
    session_id: row.session_id,
    entry_time: new Date(row.entry_time).toISOString(),
    readback: buildReadback(snapshot, { patientName: row.patient_name, timeZone: timezone }),
    unresolved_statement: unresolvedStatement(snapshot.unresolved_issues),
    confirmed_revision: row.confirmed_revision,
    confirmation_method: (row.confirmation_method ?? null) as ConfirmationMethod | null,
    confirmed_at: isoOrNull(row.confirmed_at),
    current_report_id: row.current_report_id,
    clarifications: parseColumn(clarificationListSchema, row.clarification_log, "clarification_log"),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export function reportTimeFromRow(row: DraftRow): ReportTime {
  return {
    observed_at: isoOrNull(row.observation_time),
    precision: (row.observation_time_precision ?? "unknown") as TimePrecision,
    status: (row.observation_time ? "explicit" : "unknown") as TimeStatus,
    source_text: row.observation_time_source,
  };
}

export function resolveContext(input: {
  now: Date;
  patientUnits: Partial<Record<string, string>>;
  reportTime: ReportTime;
  expressions: KnownExpression[];
}): ResolveContext {
  return {
    now: input.now,
    patientUnits: input.patientUnits,
    reportTime: input.reportTime,
    expressions: input.expressions,
    makeId: (prefix: string) => newId(prefix),
  };
}

export async function findDraftRow(session: DemoSession, draftId: string): Promise<DraftRow> {
  const rows = (await getSql()`
    select d.*, p.display_name as patient_name
    from drafts d
    join patients p on p.id = d.patient_id and p.caregiver_id = d.caregiver_id
    where d.id = ${draftId} and d.caregiver_id = ${session.caregiverId}
    limit 1
  `) as DraftRow[];
  const row = rows[0];
  if (!row) {
    throw new ApiError(404, "draft_not_found", "That draft is not part of this demo session.");
  }
  return row;
}

export async function loadDraft(session: DemoSession, draftId: string): Promise<DraftRecord> {
  return recordFromRow(await findDraftRow(session, draftId), session.timezone);
}

export async function loadCurrentDraft(session: DemoSession, patientId: string): Promise<DraftRecord | null> {
  const rows = (await getSql()`
    select d.*, p.display_name as patient_name
    from drafts d
    join patients p on p.id = d.patient_id and p.caregiver_id = d.caregiver_id
    where d.caregiver_id = ${session.caregiverId} and d.patient_id = ${patientId}
    order by d.updated_at desc
    limit 1
  `) as DraftRow[];
  const row = rows[0];
  return row ? recordFromRow(row, session.timezone) : null;
}

export async function createDraft(
  session: DemoSession,
  patient: PatientSummary,
  input: { transcript?: string },
): Promise<DraftRecord> {
  const sql = getSql();
  const draftId = newId(ID_PREFIXES.draft);
  const revisionId = newId(ID_PREFIXES.revision);
  const transcript = input.transcript ?? "";
  const snapshot: DraftSnapshot = {
    revision: 1,
    status: deriveDraftStatus({ measurements: [], observations: [], transcript, issues: [] }),
    observation_time: null,
    observation_time_precision: "assumed",
    observation_time_source_text: null,
    transcript,
    measurements: [],
    observations: [],
    unresolved_issues: [],
  };

  await sql.transaction([
    sql`
      insert into drafts (id, patient_id, caregiver_id, revision, status, original_transcript,
        observation_time, observation_time_precision, entry_time, measurements, observations,
        unresolved_issues, clarification_log)
      values (${draftId}, ${patient.id}, ${session.caregiverId}, 1, ${snapshot.status}, ${transcript},
        null, 'assumed', now(), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
    `,
    sql`
      insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
      values (${revisionId}, ${draftId}, 1, ${snapshot.status}, ${JSON.stringify(snapshot)}::jsonb, 'draft_created')
    `,
  ]);

  return loadDraft(session, draftId);
}

// ---------------------------------------------------------------------------------------------
// Applying a change
// ---------------------------------------------------------------------------------------------

function replaceById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

// A model-supplied id may be stale or invented. When it is unknown, the update still lands on the
// record it describes: one measurement of a type per report is the norm, and for observations the
// text is the natural key. Anything else becomes a new item.
export function findMeasurementToUpdate(items: Measurement[], candidate: MeasurementInput): Measurement | undefined {
  if (candidate.id) {
    const byId = items.find((item) => item.id === candidate.id);
    if (byId) return byId;
  }
  const sameType = items.filter((item) => item.type === candidate.type);
  return sameType.length === 1 ? sameType[0] : undefined;
}

export function findObservationToUpdate(items: Observation[], candidate: ObservationInput): Observation | undefined {
  if (candidate.id) {
    const byId = items.find((item) => item.id === candidate.id);
    if (byId) return byId;
  }
  const text = candidate.text?.trim().toLowerCase();
  if (!text) return undefined;
  return items.find((item) => item.text.trim().toLowerCase() === text);
}

export function applyPatchToItems(input: {
  measurements: Measurement[];
  observations: Observation[];
  patch: Omit<DraftPatch, "expected_revision" | "reason">;
  context: ResolveContext;
}): { measurements: Measurement[]; observations: Observation[]; issues: DraftIssue[] } {
  const issues: DraftIssue[] = [];
  let measurements = [...input.measurements];
  let observations = [...input.observations];

  for (const removedId of input.patch.remove_measurement_ids ?? []) {
    measurements = measurements.filter((item) => item.id !== removedId);
  }
  for (const removedId of input.patch.remove_observation_ids ?? []) {
    observations = observations.filter((item) => item.id !== removedId);
  }

  for (const candidate of input.patch.measurements ?? []) {
    const existing = findMeasurementToUpdate(measurements, candidate);
    const result = resolveMeasurement(candidate, existing, input.context);
    issues.push(...result.issues);
    measurements = replaceById(measurements, result.measurement);
  }
  for (const candidate of input.patch.observations ?? []) {
    const existing = findObservationToUpdate(observations, candidate);
    const result = resolveObservation(candidate, existing, input.context);
    issues.push(...result.issues);
    observations = replaceById(observations, result.observation);
  }

  return { measurements, observations, issues };
}

// A clarification is "settled" once no open issue points at the same code or target, so the log
// records when the caregiver answered without asking them to confirm the audit trail out loud.
const CLARIFICATION_KIND_TO_ISSUE_CODE = {
  unit: "needs_unit",
  value: "needs_value",
  time: "needs_time",
  expression: "expression_permission",
  subject: "ambiguous",
  confirmation: "ambiguous",
  generic: "ambiguous",
} as const;

function reconcileClarifications(list: Clarification[], issues: DraftIssue[], now: Date): Clarification[] {
  return list.map((entry) => {
    if (entry.answered_at) return entry;
    const stillOpen = issues.some(
      (issue) =>
        issue.code === CLARIFICATION_KIND_TO_ISSUE_CODE[entry.kind] ||
        (entry.target_id !== null && issue.target_id === entry.target_id) ||
        (entry.phrase !== null && issue.phrase === entry.phrase),
    );
    if (stillOpen) return entry;
    return { ...entry, answer: entry.answer ?? "answered in conversation", answered_at: now.toISOString() };
  });
}

export function makeClarification(input: {
  kind: Clarification["kind"];
  question: string;
  options?: string[];
  targetId?: string | null;
  phrase?: string | null;
  measurementType?: Clarification["measurement_type"];
  unit?: string | null;
  patientSpecific?: boolean | null;
  source: Clarification["source"];
  now: Date;
}): Clarification {
  return {
    id: newId(ID_PREFIXES.clarification),
    kind: input.kind,
    question: input.question,
    options: input.options ?? [],
    target_id: input.targetId ?? null,
    phrase: input.phrase ?? null,
    measurement_type: input.measurementType ?? null,
    unit: input.unit ?? null,
    patient_specific: input.patientSpecific ?? null,
    asked_at: input.now.toISOString(),
    source: input.source,
    answer: null,
    answered_at: null,
  };
}

export async function applyDraftChange(
  session: DemoSession,
  input: {
    draftId: string;
    expectedRevision: number;
    reason: DraftRevisionReason;
    // expected_revision and reason travel as top-level fields; the patch itself carries
    // only the content change, so voice-agent and typed-fallback callers omit them.
    patch: Omit<DraftPatch, "expected_revision" | "reason">;
    patientUnits: Partial<Record<string, string>>;
    expressions: KnownExpression[];
    clarification?: Clarification | null;
  },
): Promise<DraftRecord> {
  const sql = getSql();
  const row = await findDraftRow(session, input.draftId);
  if (row.revision !== input.expectedRevision) {
    throw new ApiError(
      409,
      "stale_revision",
      "This draft changed since it was loaded. The latest draft is shown instead.",
      recordFromRow(row, session.timezone),
    );
  }

  const now = new Date();
  const snapshot = snapshotFromRow(row);

  // The incoming report time applies to the items resolved in this same call. Without this,
  // a report-level "this morning" sent together with its measurements would leave every item
  // asking its own time question (spec/04 "Time policy").
  let observationTime = snapshot.observation_time;
  let precision = snapshot.observation_time_precision;
  let sourceText = snapshot.observation_time_source_text;
  let timeStatus: TimeStatus = snapshot.observation_time ? "explicit" : "unknown";
  if (input.patch.observation_time !== undefined) {
    if (input.patch.observation_time === null) {
      observationTime = null;
      precision = "unknown";
      sourceText = null;
      timeStatus = "unknown";
    } else {
      observationTime = new Date(input.patch.observation_time).toISOString();
      sourceText = input.patch.observation_time_source_text ?? null;
      // Entry time offered without the caregiver's own words stays labeled as assumed
      // (spec/04 "Time policy"); an exact instant stated without a phrase is exact.
      precision = sourceText
        ? precisionForSourceText(sourceText)
        : input.patch.observation_time_status === "unknown"
          ? "assumed"
          : "exact";
      timeStatus = input.patch.observation_time_status ?? "explicit";
    }
  }
  const context = resolveContext({
    now,
    patientUnits: input.patientUnits,
    reportTime: { observed_at: observationTime, precision, status: timeStatus, source_text: sourceText },
    expressions: input.expressions,
  });
  const merged = applyPatchToItems({
    measurements: snapshot.measurements,
    observations: snapshot.observations,
    patch: input.patch,
    context,
  });

  // Report-level questions survive item updates until they are answered or until the vocabulary
  // already contains the phrase they asked about.
  const resolvedIds = new Set(input.patch.resolve_issue_ids ?? []);
  const retained = snapshot.unresolved_issues.filter((issue) => {
    if (issue.code !== "expression_permission") return false;
    if (resolvedIds.has(issue.id)) return false;
    if (!issue.phrase) return true;
    const phrase = issue.phrase.trim().toLowerCase();
    const alreadyRemembered = input.expressions.some(
      (expression) => expression.phrase.trim().toLowerCase() === phrase,
    );
    return !alreadyRemembered;
  });

  const issues = [
    ...issuesFromResolvedItems({
      measurements: merged.measurements,
      observations: merged.observations,
      now,
      makeId: (prefix: string) => newId(prefix),
    }),
    ...retained,
  ];
  const transcript = input.patch.transcript ?? snapshot.transcript;

  const status = deriveDraftStatus({
    measurements: merged.measurements,
    observations: merged.observations,
    transcript,
    issues,
  });

  const existingClarifications = parseColumn(clarificationListSchema, row.clarification_log, "clarification_log");
  const log = [
    ...existingClarifications,
    ...(input.clarification ? [input.clarification] : []),
  ].map((entry) =>
    input.patch.answer_clarification_id === entry.id
      ? { ...entry, answer: input.patch.answer_text ?? "answered", answered_at: now.toISOString() }
      : entry,
  );
  const clarifications = reconcileClarifications(log, issues, now);

  const revision = row.revision + 1;
  const nextSnapshot: DraftSnapshot = {
    revision,
    status,
    observation_time: observationTime,
    observation_time_precision: precision,
    observation_time_source_text: sourceText,
    transcript,
    measurements: merged.measurements,
    observations: merged.observations,
    unresolved_issues: issues,
  };
  const revisionId = newId(ID_PREFIXES.revision);

  // One batched transaction. The revision row is inserted only when the guarded update matched, so
  // a stale request can never leave a trail entry behind.
  const results = await sql.transaction([
    sql`
      update drafts set
        revision = ${revision},
        status = ${status},
        original_transcript = ${transcript},
        observation_time = ${observationTime},
        observation_time_precision = ${precision},
        observation_time_source = ${sourceText},
        measurements = ${JSON.stringify(merged.measurements)}::jsonb,
        observations = ${JSON.stringify(merged.observations)}::jsonb,
        unresolved_issues = ${JSON.stringify(issues)}::jsonb,
        clarification_log = ${JSON.stringify(clarifications)}::jsonb,
        confirmed_revision = null,
        confirmation_method = null,
        confirmed_at = null,
        updated_at = now()
      where id = ${input.draftId} and caregiver_id = ${session.caregiverId} and revision = ${input.expectedRevision}
      returning id
    `,
    sql`
      insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
      select ${revisionId}, ${input.draftId}, ${revision}, ${status}, ${JSON.stringify(nextSnapshot)}::jsonb, ${input.reason}
      where exists (select 1 from drafts where id = ${input.draftId} and revision = ${revision})
    `,
  ]);

  const updated = results[0] as Array<{ id: string }>;
  if (updated.length === 0) {
    const latest = await findDraftRow(session, input.draftId);
    throw new ApiError(
      409,
      "stale_revision",
      "This draft changed since it was loaded. The latest draft is shown instead.",
      recordFromRow(latest, session.timezone),
    );
  }

  return loadDraft(session, input.draftId);
}

// ---------------------------------------------------------------------------------------------
// Confirmation and saving
// ---------------------------------------------------------------------------------------------

export async function confirmDraftRevision(
  session: DemoSession,
  input: { draftId: string; expectedRevision: number; method: ConfirmationMethod },
): Promise<DraftRecord> {
  const sql = getSql();
  const row = await findDraftRow(session, input.draftId);
  const record = recordFromRow(row, session.timezone);

  if (row.revision !== input.expectedRevision) {
    throw new ApiError(
      409,
      "stale_revision",
      "This draft changed since it was loaded. The latest draft is shown instead.",
      record,
    );
  }
  const blocking = record.unresolved_issues.filter((issue) => issue.blocking);
  if (blocking.length > 0) {
    throw new ApiError(
      409,
      "unresolved_items",
      "This report still has unanswered questions, so it cannot be confirmed yet.",
      record,
    );
  }
  if (record.status !== "REVIEWABLE" && record.status !== "DRAFT" && record.status !== "CORRECTING") {
    throw new ApiError(409, "not_reviewable", "This report is not ready for confirmation.", record);
  }

  const updated = (await sql`
    update drafts
    set status = 'CONFIRMED',
        confirmed_revision = revision,
        confirmation_method = ${input.method},
        confirmed_at = now(),
        updated_at = now()
    where id = ${input.draftId}
      and caregiver_id = ${session.caregiverId}
      and revision = ${input.expectedRevision}
      and status in ('REVIEWABLE','DRAFT','CORRECTING')
    returning id
  `) as Array<{ id: string }>;

  if (updated.length === 0) {
    const latest = await findDraftRow(session, input.draftId);
    throw new ApiError(
      409,
      "stale_revision",
      "This draft changed since it was loaded. Review the latest draft and confirm again.",
      recordFromRow(latest, session.timezone),
    );
  }

  return loadDraft(session, input.draftId);
}

export type SaveResult = {
  reportId: string;
  reused: boolean;
};

type SavedReportRow = { id: string; content_hash: string | null; idempotency_key: string };

function contentHashFor(snapshot: DraftSnapshot): string {
  return createHash("sha256").update(canonicalSnapshotString(snapshot)).digest("hex");
}

// Idempotent save (spec/05 "Save and amendment flow", FR-044/FR-046, spec/06 "Save uncertainty").
//
// Write path is one non-interactive batched transaction, in this order:
//   1. insert the report as an immutable snapshot of the confirmed revision,
//      guarded by the draft still being CONFIRMED at the expected revision,
//      with ON CONFLICT (idempotency_key) DO NOTHING for safe retries;
//   2. move the draft to SAVED and point current_report_id at the new report,
//      guarded by the report row existing, so a conflicted insert never moves the pointer.
//
// A repeated save with the same key returns the existing report (reused: true).
// Reusing the key for different content is rejected (FR-046).
export async function saveConfirmedDraft(
  session: DemoSession,
  input: { draftId: string; expectedRevision: number; confirmedRevision: number; idempotencyKey: string },
): Promise<SaveResult> {
  const sql = getSql();
  const row = await findDraftRow(session, input.draftId);
  const record = recordFromRow(row, session.timezone);

  if (row.revision !== input.expectedRevision) {
    throw new ApiError(
      409,
      "stale_revision",
      "This draft changed since it was loaded. The latest draft is shown instead.",
      record,
    );
  }

  const snapshot = snapshotFromRow(row);
  const contentHash = contentHashFor(snapshot);

  // Fast path first: a client retry after an unanswered save finds its report here even
  // though the draft already moved to SAVED (spec/06 "Save uncertainty").
  const existing = (await sql`
    select id, content_hash from reports
    where idempotency_key = ${input.idempotencyKey} and caregiver_id = ${session.caregiverId}
    limit 1
  `) as SavedReportRow[];
  const prior = existing[0];
  if (prior) {
    if (prior.content_hash !== contentHash) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "This save was already used for a different report. Confirm the current draft again to save it.",
        record,
      );
    }
    await sql`
      update drafts set status = 'SAVED', current_report_id = ${prior.id}, updated_at = now()
      where id = ${input.draftId} and caregiver_id = ${session.caregiverId}
        and revision = ${input.expectedRevision} and current_report_id is distinct from ${prior.id}
    `;
    return { reportId: prior.id, reused: true };
  }

  if (row.status !== "CONFIRMED" || row.confirmed_revision !== input.confirmedRevision || !row.confirmed_at) {
    throw new ApiError(
      409,
      "not_confirmed",
      "This report has not been confirmed yet. Review the draft and confirm it before saving.",
      record,
    );
  }

  const reportId = newId(ID_PREFIXES.report);
  const results = await sql.transaction([
    sql`
      insert into reports (id, draft_id, confirmed_revision, confirmation_method, confirmed_at,
        idempotency_key, content_hash, patient_id, caregiver_id, observation_time,
        observation_time_precision, observation_time_source, entry_time, original_transcript,
        measurements, observations)
      select ${reportId}, ${input.draftId}, ${input.confirmedRevision}, ${row.confirmation_method},
        ${row.confirmed_at}::timestamptz, ${input.idempotencyKey}, ${contentHash}, ${row.patient_id},
        ${session.caregiverId}, ${snapshot.observation_time}, ${snapshot.observation_time_precision},
        ${snapshot.observation_time_source_text}, ${row.entry_time}::timestamptz, ${snapshot.transcript},
        ${JSON.stringify(snapshot.measurements)}::jsonb, ${JSON.stringify(snapshot.observations)}::jsonb
      where exists (
        select 1 from drafts
        where id = ${input.draftId} and caregiver_id = ${session.caregiverId}
          and revision = ${input.expectedRevision} and confirmed_revision = ${input.confirmedRevision}
          and status = 'CONFIRMED'
      )
      on conflict (idempotency_key) do nothing
      returning id
    `,
    sql`
      update drafts set status = 'SAVED', current_report_id = ${reportId}, updated_at = now()
      where id = ${input.draftId} and caregiver_id = ${session.caregiverId}
        and revision = ${input.expectedRevision} and status = 'CONFIRMED'
        and exists (select 1 from reports where id = ${reportId})
      returning id
    `,
  ]);

  const inserted = results[0] as Array<{ id: string }>;
  const moved = results[1] as Array<{ id: string }>;
  if (inserted.length > 0 && moved.length > 0) {
    return { reportId, reused: false };
  }

  // Either a concurrent retry won the insert or the draft moved. Re-read to tell them apart.
  const raced = (await sql`
    select id, content_hash from reports
    where idempotency_key = ${input.idempotencyKey} and caregiver_id = ${session.caregiverId}
    limit 1
  `) as SavedReportRow[];
  const winner = raced[0];
  if (winner) {
    if (winner.content_hash !== contentHash) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "This save was already used for a different report. Confirm the current draft again to save it.",
        record,
      );
    }
    return { reportId: winner.id, reused: true };
  }

  const latest = await findDraftRow(session, input.draftId);
  throw new ApiError(
    409,
    "stale_revision",
    "This draft changed since it was loaded. Review the latest draft and confirm again.",
    recordFromRow(latest, session.timezone),
  );
}




