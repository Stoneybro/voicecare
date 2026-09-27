import { z } from "zod";
import { getSql } from "@/lib/db";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { newId, requireSession } from "@/lib/session";

const confirmSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("button") }),
  z.object({ method: z.literal("voice"), answer: z.string().trim().min(1).max(500), session_id: z.string().max(200).optional() }),
]);

function isClearAffirmation(answer: string): boolean {
  const normalized = answer.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  return new Set([
    "yes",
    "yes i confirm",
    "i confirm",
    "yes that is correct",
    "that is correct",
    "yes that's correct",
    "that's correct",
  ]).has(normalized);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const confirmation = await readJson(request, confirmSchema);
    if (confirmation.method === "voice" && !isClearAffirmation(confirmation.answer)) {
      throw new ApiError(400, "confirmation_not_explicit", "Please say a clear yes to confirm, or return to the draft to make a correction.");
    }

    const sql = getSql();
    const revisionId = newId("rev");
    const rows = (await sql`
      with updated as (
        update drafts
        set revision = revision + 1,
            status = 'CONFIRMED',
            confirmed_revision = revision + 1,
            confirmation_method = ${confirmation.method},
            confirmed_at = now(),
            session_id = coalesce(${confirmation.method === "voice" ? confirmation.session_id ?? null : null}, session_id),
            updated_at = now()
        where id = ${id} and caregiver_id = ${session.caregiverId}
          and status = 'REVIEWABLE' and unresolved_issues = '[]'::jsonb
          and confirmed_at is null
        returning id, patient_id, revision, status, original_transcript, measurements, observations,
          observation_time, observation_time_precision, observation_time_source,
          unresolved_issues, confirmation_method, confirmed_at, confirmed_revision
      ), logged as (
        insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
        select ${revisionId}, id, revision, status,
          jsonb_build_object(
            'revision', revision, 'status', status, 'patient_id', patient_id,
            'original_transcript', original_transcript, 'measurements', measurements,
            'observations', observations, 'observation_time', observation_time,
            'observation_time_precision', observation_time_precision,
            'observation_time_source', observation_time_source,
            'unresolved_issues', unresolved_issues,
            'confirmation_method', confirmation_method,
            'confirmed_at', confirmed_at,
            'confirmed_revision', confirmed_revision
          ), 'confirmation'
        from updated returning draft_id
      )
      select * from updated
    `) as Array<{
      id: string;
      revision: number;
      status: string;
      confirmation_method: string;
      confirmed_at: string;
      confirmed_revision: number;
    }>;
    if (!rows[0]) {
      const existing = (await sql`
        select status, unresolved_issues from drafts
        where id = ${id} and caregiver_id = ${session.caregiverId} limit 1
      `) as Array<{ status: string; unresolved_issues: unknown }>;
      if (!existing[0]) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
      if (existing[0].status !== "REVIEWABLE" || (Array.isArray(existing[0].unresolved_issues) && existing[0].unresolved_issues.length)) {
        throw new ApiError(409, "draft_not_ready_to_confirm", "Resolve all flagged details before confirming this draft.");
      }
      throw new ApiError(409, "draft_already_confirmed", "This draft has already been confirmed or changed.");
    }
    return jsonOk({
      draft_id: rows[0].id,
      status: rows[0].status,
      revision: rows[0].revision,
      confirmed_revision: rows[0].confirmed_revision,
      confirmation_method: rows[0].confirmation_method,
      confirmed_at: rows[0].confirmed_at,
    }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
