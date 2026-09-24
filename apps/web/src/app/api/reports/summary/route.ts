import { handle, jsonOk, parseDateRange } from "@/lib/http";
import { listSummaryReports } from "@/lib/reports";
import { requireSession, sessionPatient } from "@/lib/session";

// Summary data backing all three exports for a selected date range (FR-063 - FR-066). The client renders the
// caregiver-reported disclaimer alongside it (FR-066).
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));
    const range = parseDateRange(url);
    const reports = await listSummaryReports(session, patient.id, range);
    return jsonOk({
      disclaimer: "Caregiver-reported observations. Review before making medical decisions.",
      patient: { id: patient.id, display_name: patient.display_name },
      from: range.from,
      to: range.to,
      reports,
    });
  });
}
