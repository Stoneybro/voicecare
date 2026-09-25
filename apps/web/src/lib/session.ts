// Anonymous, browser-scoped demo sessions (spec/01 "Assumptions", stage 1.3/1.4).
//
// The browser holds one random opaque token in an HttpOnly cookie. Only its SHA-256 hash is
// stored, and every database read or write is scoped to the caregiver resolved from it, so one
// judge can never see another browser's demo records. First visit creates a demo session, a
// fictional caregiver, and two fictional patients in one transaction — no login, no setup.

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getSql } from "./db";
import { ApiError } from "./http";

export const SESSION_COOKIE_NAME = "vc_demo_session";
export const SESSION_TTL_HOURS = 72;
export const FICTIONAL_CAREGIVER_NAME = "Demo caregiver";
export const FICTIONAL_PATIENT_NAMES = ["Rosa", "John"];

const TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

export type PatientSummary = {
  id: string;
  display_name: string;
  preferred_units: Record<string, unknown>;
};

export type DemoSession = {
  id: string;
  expiresAt: string;
  createdAt: string;
  caregiverId: string;
  caregiverName: string;
  timezone: string;
  patients: PatientSummary[];
  isNew: boolean;
};

export function newId(prefixName: string): string {
  return `${prefixName}_${randomBytes(10).toString("hex")}`;
}

function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: string | null | undefined): string {
  if (value && isValidTimeZone(value)) return value;
  return "UTC";
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Hosted builds are HTTPS-only; local development runs on http://localhost.
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

type SessionRow = { id: string; expires_at: string; created_at: string };
type CaregiverRow = { id: string; display_name: string; timezone: string };
type PatientRow = { id: string; display_name: string; preferred_units: unknown };

function toPatientSummary(row: PatientRow): PatientSummary {
  const units =
    row.preferred_units && typeof row.preferred_units === "object" && !Array.isArray(row.preferred_units)
      ? (row.preferred_units as Record<string, unknown>)
      : {};
  return { id: row.id, display_name: row.display_name, preferred_units: units };
}

async function loadSessionContext(session: SessionRow, timezone: string, isNew: boolean): Promise<DemoSession> {
  const sql = getSql();
  const caregiverRows = (await sql`
    select id, display_name, timezone from caregivers where demo_session_id = ${session.id} limit 1
  `) as CaregiverRow[];
  const caregiver = caregiverRows[0];
  if (!caregiver) {
    throw new ApiError(500, "session_broken", "The demo workspace is incomplete. Reset the demo to continue.");
  }
  const patientRows = (await sql`
    select id, display_name, preferred_units from patients
    where caregiver_id = ${caregiver.id} order by created_at asc
  `) as PatientRow[];

  return {
    id: session.id,
    expiresAt: new Date(session.expires_at).toISOString(),
    createdAt: new Date(session.created_at).toISOString(),
    caregiverId: caregiver.id,
    caregiverName: caregiver.display_name,
    timezone: normalizeTimeZone(caregiver.timezone) === "UTC" ? timezone : caregiver.timezone,
    patients: patientRows.map(toPatientSummary),
    isNew,
  };
}

async function createSession(timezone: string): Promise<DemoSession> {
  const sql = getSql();
  const sessionId = newId("sess");
  const caregiverId = newId("cg");
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + TTL_MS);

  const patientIds = FICTIONAL_PATIENT_NAMES.map(() => newId("pat"));
  const tokenHash = hashToken(token);

  // One transaction bootstraps the whole workspace (stage 1.3).
  await sql.transaction([
    sql`
      insert into demo_sessions (id, token_hash, expires_at)
      values (${sessionId}, ${tokenHash}, ${expiresAt})
    `,
    sql`
      insert into caregivers (id, demo_session_id, display_name, timezone)
      values (${caregiverId}, ${sessionId}, ${FICTIONAL_CAREGIVER_NAME}, ${timezone})
    `,
    ...FICTIONAL_PATIENT_NAMES.map(
      (name, index) => sql`
        insert into patients (id, caregiver_id, display_name)
        values (${patientIds[index]}, ${caregiverId}, ${name})
      `,
    ),
  ]);

  await setSessionCookie(token, expiresAt);

  return {
    id: sessionId,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    caregiverId,
    caregiverName: FICTIONAL_CAREGIVER_NAME,
    timezone,
    patients: FICTIONAL_PATIENT_NAMES.map((name, index) => ({
      id: patientIds[index],
      display_name: name,
      preferred_units: {},
    })),
    isNew: true,
  };
}

export async function bootstrapSession(timezoneInput: string | null): Promise<DemoSession> {
  const sql = getSql();
  const timezone = normalizeTimeZone(timezoneInput);
  const token = await readSessionToken();

  if (token) {
    const rows = (await sql`
      select id, expires_at, created_at
      from demo_sessions
      where token_hash = ${hashToken(token)} and invalidated_at is null and expires_at > now()
      limit 1
    `) as SessionRow[];
    const session = rows[0];
    if (session) {
      // Sliding expiry: the demo session lasts 72 hours after its last use (spec/01).
      const expiresAt = new Date(Date.now() + TTL_MS);
      await sql`update demo_sessions set last_seen_at = now(), expires_at = ${expiresAt} where id = ${session.id}`;
      return loadSessionContext({ ...session, expires_at: expiresAt.toISOString() }, timezone, false);
    }
  }

  return createSession(timezone);
}

// Stage 1.7: wipe the caregiver's data and hand back a clean workspace. The old token can no
// longer resolve a session, so a reset also cuts off any stale copy of the browser state.
export async function resetSession(timezoneInput: string | null): Promise<DemoSession> {
  const sql = getSql();
  const token = await readSessionToken();
  if (token) {
    await sql`
      update demo_sessions set invalidated_at = now()
      where token_hash = ${hashToken(token)} and invalidated_at is null
    `;
    await clearSessionCookie();
  }
  return createSession(normalizeTimeZone(timezoneInput));
}

// Stage 1.4: every request resolves the caregiver from the cookie; expired or invalid sessions
// are rejected cleanly so the browser can re-bootstrap by reloading.
export async function requireSession(): Promise<DemoSession> {
  const sql = getSql();
  const token = await readSessionToken();
  if (!token) {
    throw new ApiError(
      401,
      "session_required",
      "Your demo session was not found. Reloading the page creates a new one.",
    );
  }
  const rows = (await sql`
    select id, expires_at, created_at
    from demo_sessions
    where token_hash = ${hashToken(token)} and invalidated_at is null and expires_at > now()
    limit 1
  `) as SessionRow[];
  const session = rows[0];
  if (!session) {
    throw new ApiError(
      401,
      "session_expired",
      "Your demo session expired. Reloading the page creates a new one.",
    );
  }
  // Keep the caregiver's stored timezone instead of trusting the current request's zone.
  const timezoneRows = (await sql`
    select timezone from caregivers where demo_session_id = ${session.id} limit 1
  `) as Array<{ timezone: string }>;
  const storedTimezone = timezoneRows[0]?.timezone;
  return loadSessionContext(session, normalizeTimeZone(storedTimezone ?? null), false);
}

export async function sessionPatient(
  session: DemoSession,
  patientId: string | null,
): Promise<PatientSummary> {
  const patient = patientId
    ? session.patients.find((candidate) => candidate.id === patientId)
    : session.patients[0];
  if (!patient) {
    throw new ApiError(404, "patient_not_found", "That patient is not part of this demo session.");
  }
  return patient;
}

// Measurement type -> confirmed unit; later stages use this before asking the caregiver.
export function patientPreferredUnits(patient: PatientSummary): Partial<Record<string, string>> {
  const units: Partial<Record<string, string>> = {};
  for (const [type, unit] of Object.entries(patient.preferred_units)) {
    if (typeof unit === "string") units[type] = unit;
  }
  return units;
}
