// Patient management for continuity of care across several people.
// The schema was already multi-patient ready; this exposes it:
//   POST /api/patients { display_name } -> created patient (scoped to caregiver)
import { z } from "zod";
import { handle, jsonOk, readJson } from "@/lib/http";
import { getSql } from "@/lib/db";
import { ID_PREFIXES } from "@voicecare/shared";
import { newId, requireSession } from "@/lib/session";

const patientCreateSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
});

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, patientCreateSchema);
    const sql = getSql();
    const patientId = newId(ID_PREFIXES.patient);
    await sql`
      insert into patients (id, caregiver_id, display_name, preferred_units)
      values (${patientId}, ${session.caregiverId}, ${body.display_name}, '{}'::jsonb)
    `;
    return jsonOk({ id: patientId, display_name: body.display_name, preferred_units: {} });
  });
}
