import { z } from "zod";
import { bootstrapPayload } from "@/lib/bootstrap";
import { getSql } from "@/lib/db";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { newId, requireSession } from "@/lib/session";
import type { PatientSummary } from "@/lib/session";

const patientCreateSchema = z.object({
  display_name: z.string().trim().min(1).max(60),
});

// Stage 1.6: create a new patient inside this browser's demo workspace.
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, patientCreateSchema);
    const sql = getSql();
    const trimmedName = body.display_name.trim();
    // Friendly guard so the judge cannot accidentally create two patients with the same name.
    const existing = (await sql`
      select id from patients
      where caregiver_id = ${session.caregiverId} and display_name = ${trimmedName}
      limit 1
    `) as Array<{ id: string }>;
    if (existing.length > 0) {
      throw new ApiError(
        409,
        "duplicate_patient",
        `A patient named "${trimmedName}" already exists in this workspace.`,
      );
    }
    const id = newId("pat");
    await sql`
      insert into patients (id, caregiver_id, display_name)
      values (${id}, ${session.caregiverId}, ${trimmedName})
    `;
    const patient: PatientSummary = { id, display_name: trimmedName, preferred_units: {} };
    // Return the refreshed workspace payload so the UI can swap its whole state in one step.
    return jsonOk({ patient, ...(await bootstrapPayload({ ...session, patients: [...session.patients, patient] })) });
  });
}
