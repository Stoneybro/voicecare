import { createDraft, loadCurrentDraft } from "@/lib/drafts";
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

// Current (most recently updated) draft for one patient, so switching patients in
// the UI loads each person's own in-progress note instead of Rosa's.
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));
    return jsonOk({ draft: await loadCurrentDraft(session, patient.id) });
  });
}
