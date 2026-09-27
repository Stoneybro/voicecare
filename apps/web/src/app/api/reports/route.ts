import { createHash } from "node:crypto";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { requireSession, sessionPatient } from "@/lib/session";

const saveSchema = z.object({ draft_id: z.string().min(1).max(100) });

type DraftSnapshot = {
  id: string;
  patient_id: string;
  caregiver_id: string;
  revision: number;
  status: string;
  confirmed_revision: number | null;
  confirmation_method: "button" | "voice" | null;
  confirmed_at: string | null;
  created_at: string;
  original_transcript: string;
  observation_time: string | null;
  observation_time_precision: string;
  observation_time_source: string | null;
  measurements: unknown;
  observations: unknown;
  unresolved_issues: unknown;
};

type ReportRow = {
  id: string;
  draft_id: string;
  patient_id: string;
  caregiver_id: string;
  confirmed_revision: number;
  content_hash: string;
  saved_at: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reportContentHash(draft: DraftSnapshot): string {
  const snapshot = {
    draft_id: draft.id,
    patient_id: draft.patient_id,
    caregiver_id: draft.caregiver_id,
    confirmed_revision: draft.confirmed_revision,
    confirmation_method: draft.confirmation_method,
    confirmed_at: draft.confirmed_at ? new Date(draft.confirmed_at).toISOString() : null,
    observation_time: draft.observation_time ? new Date(draft.observation_time).toISOString() : null,
    observation_time_precision: draft.observation_time_precision,
    observation_time_source: draft.observation_time_source,
    entry_time: new Date(draft.created_at).toISOString(),
    original_transcript: draft.original_transcript,
    measurements: draft.measurements,
    observations: draft.observations,
  };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const key = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
      throw new ApiError(400, "idempotency_key_required", "Include a valid Idempotency-Key header and retry the save.");
    }
    const { draft_id: draftId } = await readJson(request, saveSchema);
    const sql = getSql();
    const rows = (await sql`
      select id, patient_id, caregiver_id, revision, status, confirmed_revision,
        confirmation_method, confirmed_at, created_at, original_transcript,
        observation_time, observation_time_precision, observation_time_source,
        measurements, observations, unresolved_issues
      from drafts
      where id = ${draftId} and caregiver_id = ${session.caregiverId}
      limit 1
    `) as DraftSnapshot[];
    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
    if (!draft.confirmed_at || draft.confirmed_revision === null || draft.confirmed_revision !== draft.revision ||
      !draft.confirmation_method || !["CONFIRMED", "SAVED"].includes(draft.status) ||
      !Array.isArray(draft.unresolved_issues) || draft.unresolved_issues.length > 0) {
      throw new ApiError(409, "draft_not_confirmed", "Only a fully confirmed current revision can be saved as a report.");
    }

    const contentHash = reportContentHash(draft);
    const keyRows = (await sql`
      select id, draft_id, patient_id, caregiver_id, confirmed_revision, content_hash, saved_at
      from reports where idempotency_key = ${key} limit 1
    `) as ReportRow[];
    const keyMatch = keyRows[0];
    if (keyMatch) {
      if (keyMatch.caregiver_id && keyMatch.caregiver_id !== session.caregiverId) {
        throw new ApiError(409, "idempotency_key_reused", "That save key was already used for a different report.");
      }
      if (keyMatch.content_hash !== contentHash || keyMatch.draft_id !== draft.id) {
        throw new ApiError(409, "idempotency_key_reused", "That save key was already used for different report content.");
      }
      return jsonOk({ report_id: keyMatch.id, draft_id: keyMatch.draft_id, saved_at: keyMatch.saved_at, reused: true });
    }

    const revisionRows = (await sql`
      select id, draft_id, patient_id, caregiver_id, confirmed_revision, content_hash, saved_at
      from reports where draft_id = ${draft.id} and confirmed_revision = ${draft.confirmed_revision}
        and caregiver_id = ${session.caregiverId} limit 1
    `) as ReportRow[];
    const existingRevision = revisionRows[0];
    if (existingRevision) {
      if (existingRevision.content_hash !== contentHash) {
        throw new ApiError(409, "report_snapshot_mismatch", "The saved report does not match this confirmed revision.");
      }
      return jsonOk({ report_id: existingRevision.id, draft_id: draft.id, saved_at: existingRevision.saved_at, reused: true });
    }

    const reportId = `report_${createHash("sha256").update(`${draft.id}:${draft.confirmed_revision}`).digest("hex").slice(0, 24)}`;
    await sql.transaction([
      sql`
        insert into reports (
          id, draft_id, confirmed_revision, confirmation_method, confirmed_at,
          idempotency_key, content_hash, patient_id, caregiver_id,
          observation_time, observation_time_precision, observation_time_source,
          entry_time, original_transcript, measurements, observations
        ) values (
          ${reportId}, ${draft.id}, ${draft.confirmed_revision}, ${draft.confirmation_method}, ${draft.confirmed_at},
          ${key}, ${contentHash}, ${draft.patient_id}, ${draft.caregiver_id},
          ${draft.observation_time}, ${draft.observation_time_precision}, ${draft.observation_time_source},
          ${draft.created_at}, ${draft.original_transcript}, ${JSON.stringify(draft.measurements)}::jsonb,
          ${JSON.stringify(draft.observations)}::jsonb
        ) on conflict do nothing
      `,
      sql`
        update drafts d
        set status = 'SAVED',
            current_report_id = r.id,
            updated_at = now()
        from reports r
        where d.id = ${draft.id} and d.caregiver_id = ${session.caregiverId}
          and d.revision = ${draft.confirmed_revision}
          and d.confirmed_revision = d.revision and d.confirmed_at is not null
          and d.status in ('CONFIRMED','SAVED')
          and r.draft_id = d.id and r.confirmed_revision = d.revision
          and r.caregiver_id = d.caregiver_id and r.content_hash = ${contentHash}
      `,
    ]);

    const savedRows = (await sql`
      select id, draft_id, patient_id, caregiver_id, confirmed_revision, content_hash, saved_at
      from reports where draft_id = ${draft.id} and confirmed_revision = ${draft.confirmed_revision}
        and caregiver_id = ${session.caregiverId} limit 1
    `) as ReportRow[];
    const saved = savedRows[0];
    if (!saved || saved.content_hash !== contentHash) {
      const conflictingKey = (await sql`
        select id from reports where idempotency_key = ${key} and caregiver_id = ${session.caregiverId} limit 1
      `) as Array<{ id: string }>;
      if (conflictingKey.length) throw new ApiError(409, "idempotency_key_reused", "That save key was already used for different report content.");
      throw new ApiError(409, "draft_changed", "The confirmed draft changed before the report could be saved. Review and confirm it again.");
    }
    return jsonOk({ report_id: saved.id, draft_id: saved.draft_id, saved_at: saved.saved_at, reused: saved.id !== reportId });
  });
}

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const patientId = new URL(request.url).searchParams.get("patient_id");
    if (patientId) await sessionPatient(session, patientId);
    const rows = await getSql()`
      select r.id, r.draft_id, r.patient_id, p.display_name as patient_name,
        r.confirmed_revision, r.confirmation_method, r.confirmed_at,
        r.observation_time, r.observation_time_precision, r.entry_time, r.saved_at,
        r.measurements, r.observations
      from reports r
      join patients p on p.id = r.patient_id and p.caregiver_id = r.caregiver_id
      where r.caregiver_id = ${session.caregiverId}
        and (${patientId}::text is null or r.patient_id = ${patientId})
      order by coalesce(r.observation_time, r.entry_time) desc, r.saved_at desc
    `;
    return jsonOk({ reports: rows }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
