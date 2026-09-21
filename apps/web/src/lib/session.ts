// Anonymous, browser-scoped demo sessions (spec/05 "Demo session", spec/06 "Access and secrets").
//
// The browser holds one random opaque token in an HttpOnly cookie. Only its SHA-256 hash is stored,
// and every database read or write is scoped to the caregiver resolved from it. The browser never
// sends a caregiver or session identifier that establishes ownership.

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { DEMO_SESSION_TTL_HOURS, ID_PREFIXES, isValidTimeZone } from "@voicecare/shared";
import { getSql } from "./db";
import { ApiError } from "./http";

export const SESSION_COOKIE_NAME = "vc_demo_session";
export const FICTIONAL_CAREGIVER_NAME = "Demo caregiver";
export const FICTIONAL_PATIENT_NAME = "Rosa";
const TTL_MS = DEMO_SESSION_TTL_HOURS * 60 * 60 * 1000;

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

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
  let caregiver = caregiverRows[0];

  if (!caregiver) {
    // Defensive: an earlier schema revision could leave a session without its fictional caregiver.
    const caregiverId = newId(ID_PREFIXES.caregiver);
    const patientId = newId(ID_PREFIXES.patient);
    await sql.transaction([
      sql`insert into caregivers (id, demo_session_id, display_name, timezone) values (${caregiverId}, ${session.id}, ${FICTIONAL_CAREGIVER_NAME}, ${timezone})`,
      sql`insert into patients (id, caregiver_id, display_name, preferred_units) values (${patientId}, ${caregiverId}, ${FICTIONAL_PATIENT_NAME}, '{}'::jsonb)`,
    ]);
    caregiver = { id: caregiverId, display_name: FICTIONAL_CAREGIVER_NAME, timezone };
  } else if (timezone !== caregiver.timezone) {
    await sql`update caregivers set timezone = ${timezone} where id = ${caregiver.id}`;
    caregiver = { ...caregiver, timezone };
  }

  const patientRows = (await sql`
    select id, display_name, preferred_units from patients where caregiver_id = ${caregiver.id} order by created_at asc
  `) as PatientRow[];

  return {
    id: session.id,
    expiresAt: new Date(session.expires_at).toISOString(),
    createdAt: new Date(session.created_at).toISOString(),
    caregiverId: caregiver.id,
    caregiverName: caregiver.display_name,
    timezone: caregiver.timezone,
    patients: patientRows.map(toPatientSummary),
    isNew,
  };
}

async function createSession(timezone: string): Promise<DemoSession> {
  const sql = getSql();
  const token = newSessionToken();
  const sessionId = newId(ID_PREFIXES.demoSession);
  const caregiverId = newId(ID_PREFIXES.caregiver);
  const patientId = newId(ID_PREFIXES.patient);
  const expiresAt = new Date(Date.now() + TTL_MS);

  // One batched, ordered transaction: session, then its fictional caregiver and patient.
  await sql.transaction([
    sql`insert into demo_sessions (id, token_hash, expires_at) values (${sessionId}, ${hashToken(token)}, ${expiresAt})`,
    sql`insert into caregivers (id, demo_session_id, display_name, timezone) values (${caregiverId}, ${sessionId}, ${FICTIONAL_CAREGIVER_NAME}, ${timezone})`,
    sql`insert into patients (id, caregiver_id, display_name, preferred_units) values (${patientId}, ${caregiverId}, ${FICTIONAL_PATIENT_NAME}, '{}'::jsonb)`,
  ]);

  await setSessionCookie(token, expiresAt);

  return {
    id: sessionId,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    caregiverId,
    caregiverName: FICTIONAL_CAREGIVER_NAME,
    timezone,
    patients: [{ id: patientId, display_name: FICTIONAL_PATIENT_NAME, preferred_units: {} }],
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
      // Sliding expiry: the session lasts 72 hours after its last use (spec/06).
      const expiresAt = new Date(Date.now() + TTL_MS);
      await sql`update demo_sessions set last_seen_at = now(), expires_at = ${expiresAt} where id = ${session.id}`;
      return loadSessionContext({ ...session, expires_at: expiresAt.toISOString() }, timezone, false);
    }
  }

  return createSession(timezone);
}

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
  // Keep the caregiver's stored timezone: passing a different zone here would overwrite it
  // and render every readback in the wrong time.
  const timezoneRows = (await sql`
    select timezone from caregivers where demo_session_id = ${session.id} limit 1
  `) as Array<{ timezone: string }>;
  return loadSessionContext(session, normalizeTimeZone(timezoneRows[0]?.timezone), false);
}

export async function sessionPatient(session: DemoSession, patientId: string | null): Promise<PatientSummary> {
  const patient = patientId ? session.patients.find((candidate) => candidate.id === patientId) : session.patients[0];
  if (!patient) {
    throw new ApiError(404, "patient_not_found", "That patient is not part of this demo session.");
  }
  return patient;
}

export function patientPreferredUnits(patient: PatientSummary): Partial<Record<string, string>> {
  const units: Partial<Record<string, string>> = {};
  for (const [type, unit] of Object.entries(patient.preferred_units)) {
    if (typeof unit === "string") units[type] = unit;
  }
  return units;
}

