import { createDraft } from "@/lib/drafts";
import { handle, jsonOk, readJson } from "@/lib/http";
import { requireSession, sessionPatient } from "@/lib/session";
import { draftCreateSchema } from "@voicecare/shared";

// Start a session draft for the selected patient.
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, draftCreateSchema);
    const patient = await sessionPatient(session, body.patient_id ?? null);
    return jsonOk(await createDraft(session, patient, { transcript: body.transcript }));
  });
}
