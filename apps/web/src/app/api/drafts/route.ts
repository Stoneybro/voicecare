import { z } from "zod";
import { getSql } from "@/lib/db";
import { handle, jsonOk, readJson } from "@/lib/http";
import { newId, requireSession, sessionPatient } from "@/lib/session";

const createDraftSchema = z.object({ patient_id: z.string().min(1).max(100) });

// Stage 2.4: create an empty CAPTURING draft for a patient in this browser's workspace.
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { patient_id: patientId } = await readJson(request, createDraftSchema);
    const patient = await sessionPatient(session, patientId);
    const sql = getSql();
    const draftId = newId("draft");
    const revisionId = newId("rev");

    await sql.transaction([
      sql`
        insert into drafts (id, patient_id, caregiver_id, status, original_transcript)
        values (${draftId}, ${patient.id}, ${session.caregiverId}, 'CAPTURING', '')
      `,
      sql`
        insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
        values (
          ${revisionId}, ${draftId}, 1, 'CAPTURING',
          jsonb_build_object('revision', 1, 'status', 'CAPTURING', 'original_transcript', ''),
          'capture_started'
        )
      `,
    ]);

    return jsonOk({ draft_id: draftId, status: "CAPTURING" }, { status: 201 });
  });
}
