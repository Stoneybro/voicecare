import { z } from "zod";
import { getSql } from "@/lib/db";
import { extractTranscript } from "@/lib/extraction";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { newId, requireSession } from "@/lib/session";

const finalizeDraftSchema = z.object({
  original_transcript: z.string().trim().min(1).max(30_000),
});

type DraftRow = {
  id: string;
  patient_id: string;
  revision: number;
  status: string;
  original_transcript: string;
  measurements: unknown;
  observations: unknown;
  observation_time: string | null;
  observation_time_precision: string;
  observation_time_source: string | null;
  unresolved_issues: unknown;
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const { original_transcript: transcript } = await readJson(request, finalizeDraftSchema);
    const sql = getSql();
    const revisionId = newId("rev");
    const extraction = extractTranscript(transcript, { timeZone: session.timezone });
    const status = extraction.unresolved_issues.length > 0 ? "NEEDS_CLARIFICATION" : "REVIEWABLE";

    // Update and append the immutable revision snapshot in one statement. The owner and state
    // predicates make an unowned or already-finalized draft impossible to mutate through this API.
    const rows = (await sql`
      with updated as (
        update drafts
        set original_transcript = ${transcript},
            status = ${status},
            revision = revision + 1,
            measurements = ${JSON.stringify(extraction.measurements)}::jsonb,
            observations = ${JSON.stringify(extraction.observations)}::jsonb,
            observation_time = ${extraction.observation_time},
            observation_time_precision = ${extraction.observation_time_precision},
            observation_time_source = ${extraction.observation_time_source},
            unresolved_issues = ${JSON.stringify(extraction.unresolved_issues)}::jsonb,
            updated_at = now()
        where id = ${id}
          and caregiver_id = ${session.caregiverId}
          and status = 'CAPTURING'
        returning id, patient_id, revision, status, original_transcript, measurements, observations,
          observation_time, observation_time_precision, observation_time_source, unresolved_issues
      ), logged as (
        insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
        select ${revisionId}, id, revision, status,
          jsonb_build_object(
            'revision', revision,
            'status', status,
            'patient_id', patient_id,
            'original_transcript', original_transcript,
            'measurements', measurements,
            'observations', observations,
            'observation_time', observation_time,
            'observation_time_precision', observation_time_precision,
            'observation_time_source', observation_time_source,
            'unresolved_issues', unresolved_issues
          ),
          'transcript_captured'
        from updated
        returning draft_id
      )
      select id, patient_id, revision, status, original_transcript, measurements, observations,
        observation_time, observation_time_precision, observation_time_source, unresolved_issues
      from updated
    `) as DraftRow[];

    if (rows[0]) {
      return jsonOk({
        draft_id: rows[0].id,
        status: rows[0].status,
        revision: rows[0].revision,
        measurements: rows[0].measurements,
        observations: rows[0].observations,
        observation_time: rows[0].observation_time,
        observation_time_precision: rows[0].observation_time_precision,
        observation_time_source: rows[0].observation_time_source,
        unresolved_issues: rows[0].unresolved_issues,
      });
    }

    const existing = (await sql`
      select id, revision, status, original_transcript, measurements, observations,
        observation_time, observation_time_precision, observation_time_source, unresolved_issues
      from drafts
      where id = ${id} and caregiver_id = ${session.caregiverId}
      limit 1
    `) as DraftRow[];

    if (!existing[0]) {
      throw new ApiError(404, "draft_not_found", "That recording could not be found in this demo workspace.");
    }
    if (
      ["NEEDS_CLARIFICATION", "REVIEWABLE"].includes(existing[0].status) &&
      existing[0].original_transcript === transcript
    ) {
      return jsonOk({ draft_id: id, ...existing[0] });
    }
    throw new ApiError(409, "draft_not_capturing", "This recording has already been finalized.");
  });
}

// Stage 3 review loads only a draft owned by the current demo session.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const rows = (await getSql()`
      select d.id, d.patient_id, p.display_name as patient_name, d.revision, d.status,
        d.original_transcript, d.measurements, d.observations, d.observation_time,
        d.observation_time_precision, d.observation_time_source, d.unresolved_issues
      from drafts d
      join patients p on p.id = d.patient_id and p.caregiver_id = d.caregiver_id
      where d.id = ${id} and d.caregiver_id = ${session.caregiverId}
      limit 1
    `) as Array<{
      id: string;
      patient_id: string;
      patient_name: string;
      revision: number;
      status: string;
      original_transcript: string;
      measurements: unknown;
      observations: unknown;
      observation_time: string | null;
      observation_time_precision: string;
      observation_time_source: string | null;
      unresolved_issues: unknown;
    }>;

    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
    if (!["NEEDS_CLARIFICATION", "REVIEWABLE"].includes(draft.status)) {
      throw new ApiError(409, "draft_not_ready", "This draft is not ready for review yet.");
    }
    return jsonOk({ draft });
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const deleted = await getSql()`
      delete from drafts
      where id = ${id} and caregiver_id = ${session.caregiverId} and status = 'CAPTURING'
      returning id
    `;
    if (deleted.length === 0) {
      throw new ApiError(404, "capturing_draft_not_found", "The unfinished recording could not be found.");
    }
    return jsonOk({ draft_id: id, deleted: true });
  });
}
