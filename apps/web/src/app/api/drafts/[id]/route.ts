import { applyDraftChange, loadDraft } from "@/lib/drafts";
import { listKnownExpressions } from "@/lib/expressions";
import { handle, jsonOk, readJson } from "@/lib/http";
import { patientPreferredUnits, requireSession, sessionPatient } from "@/lib/session";
import { draftPatchSchema } from "@voicecare/shared";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    return jsonOk(await loadDraft(session, (await params).id));
  });
}

// Visible draft editing: every request carries the revision it expects, and a stale request
// is rejected with the latest draft (FR-036). A change clears any confirmation (FR-034).
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const draftId = (await params).id;
    const patch = await readJson(request, draftPatchSchema);
    const row = await loadDraft(session, draftId);
    const patient = await sessionPatient(session, row.patient_id);
    return jsonOk(
      await applyDraftChange(session, {
        draftId,
        expectedRevision: patch.expected_revision,
        reason: patch.reason,
        patch,
        patientUnits: patientPreferredUnits(patient),
        expressions: await listKnownExpressions(session.caregiverId, row.patient_id),
      }),
    );
  });
}
