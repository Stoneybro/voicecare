import { getSql } from "./db";
import type { DemoSession, PatientSummary } from "./session";

// Response shapes shared by /api/bootstrap, /api/patients, and /api/demo, and consumed by the
// home screen. Kept here so the routes and the UI cannot drift apart.

export type BootstrapPayload = {
  session: {
    id: string;
    expires_at: string;
    created_at: string;
    is_new: boolean;
  };
  caregiver: {
    id: string;
    display_name: string;
    timezone: string;
  };
  patients: PatientSummary[];
  reports_count: number;
};

export async function countReports(caregiverId: string): Promise<number> {
  const rows = (await getSql()`
    select count(*)::int as count from reports where caregiver_id = ${caregiverId}
  `) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

export async function bootstrapPayload(session: DemoSession): Promise<BootstrapPayload> {
  const reportsCount = await countReports(session.caregiverId).catch(() => 0);
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
    patients: session.patients,
    reports_count: reportsCount,
  };
}
