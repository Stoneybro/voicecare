import { handle, jsonOk, parseDateRange } from "@/lib/http";
import { listCurrentReports } from "@/lib/reports";
import { requireSession, sessionPatient } from "@/lib/session";

// Session-scoped history of current confirmed reports (FR-060). Superseded revisions are
// excluded by default; each item links to the report detail for the audit trail.
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));
    const range = parseDateRange(url);
    return jsonOk(await listCurrentReports(session, patient.id, range));
  });
}
