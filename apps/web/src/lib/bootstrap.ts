// Bootstrap payload shared by GET /api/bootstrap and POST /api/reset: the anonymous demo
// session, the fictional caregiver and patient, the current draft, remembered expressions,
// and the report count the home screen needs before showing "Ready to speak" (spec/02
// "Remote-judge startup and reset flow").

import type { BootstrapResponse } from "@voicecare/shared";
import { loadCurrentDraft } from "./drafts";
import { countReports } from "./reports";
import { listExpressions } from "./expressions";
import type { DemoSession } from "./session";

export async function bootstrapPayload(session: DemoSession): Promise<BootstrapResponse> {
  const patient = session.patients[0];
  const [currentDraft, expressions, reportsCount] = await Promise.all([
    patient ? loadCurrentDraft(session, patient.id) : Promise.resolve(null),
    listExpressions(session.caregiverId, patient?.id ?? null).catch(() => []),
    countReports(session.caregiverId).catch(() => 0),
  ]);
  return {
    session: {
      id: session.id,
      expires_at: session.expiresAt,
      created_at: session.createdAt,
      is_new: session.isNew,
    },
    caregiver: {
      id: session.caregiverId,
      display_name: session.caregiverName,
      timezone: session.timezone,
    },
    patients: session.patients.map((candidate) => ({
      id: candidate.id,
      display_name: candidate.display_name,
      preferred_units: candidate.preferred_units as Record<string, unknown>,
    })),
    current_draft: currentDraft,
    expressions,
    reports_count: reportsCount,
  };
}
