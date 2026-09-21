import {
  createExpression,
  listExpressions,
} from "@/lib/expressions";
import { handle, jsonOk, readJson } from "@/lib/http";
import { requireSession, sessionPatient } from "@/lib/session";
import { expressionCreateSchema } from "@voicecare/shared";

// Remembered personal expressions, scoped to this demo session's caregiver (FR-052).
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patientId = url.searchParams.get("patient_id");
    if (patientId) await sessionPatient(session, patientId);
    return jsonOk(await listExpressions(session.caregiverId, patientId));
  });
}

// Stored only after separate, explicit permission to remember it (FR-050). The client sends
// this only after the caregiver confirms, and the payload documents that consent.
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));
    const body = await readJson(request, expressionCreateSchema);
    return jsonOk(await createExpression(session.caregiverId, patient.id, body), { status: 201 });
  });
}
