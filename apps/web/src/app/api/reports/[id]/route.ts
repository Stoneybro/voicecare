import { getSql } from "@/lib/db";
import { ApiError, handle, jsonOk } from "@/lib/http";
import { requireSession } from "@/lib/session";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const rows = await getSql()`
      select r.id, r.draft_id, r.patient_id, p.display_name as patient_name,
        r.confirmed_revision, r.confirmation_method, r.confirmed_at,
        r.observation_time, r.observation_time_precision, r.observation_time_source,
        r.entry_time, r.original_transcript, r.measurements, r.observations, r.saved_at
      from reports r
      join patients p on p.id = r.patient_id and p.caregiver_id = r.caregiver_id
      where r.id = ${id} and r.caregiver_id = ${session.caregiverId}
      limit 1
    `;
    if (!rows[0]) throw new ApiError(404, "report_not_found", "That saved report could not be found in this demo workspace.");
    return jsonOk({ report: rows[0] }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
