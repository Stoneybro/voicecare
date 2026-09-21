// Database access (spec/05 "Database decision").
//
// The prototype uses PostgreSQL on Neon through the serverless HTTP driver: one statement per
// request, plus non-interactive batched transactions for the two-statement save path. Reads and
// writes are always scoped by the caregiver resolved from the anonymous demo session.

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type Sql = NeonQueryFunction<false, false>;

let client: Sql | null = null;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not set");
    this.name = "DatabaseNotConfiguredError";
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new DatabaseNotConfiguredError();
  if (!client) {
    client = neon(url);
  }
  return client;
}

export async function pingDatabase(): Promise<boolean> {
  if (!isDatabaseConfigured()) return false;
  try {
    await getSql()`select 1 as ok`;
    return true;
  } catch (error) {
    console.error("[voicecare] database ping failed", error);
    return false;
  }
}

// Provider errors and stack traces stay in the server log; the caregiver sees a friendly retry
// message instead (spec/07 "Unattended deployment checks").
export function friendlyDatabaseMessage(error: unknown): string {
  if (error instanceof DatabaseNotConfiguredError) {
    return "The demo database is not configured yet. Add DATABASE_URL and try again.";
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (/relation .* does not exist/i.test(detail)) {
    return "The demo database is not initialised yet. Apply db/schema.sql and try again.";
  }
  if (/terminat|ECONNREFUSED|ETIMEDOUT|fetch failed|too many|connection/i.test(detail)) {
    return "The demo database is waking up. Please wait a moment and try again.";
  }
  return "Something went wrong while talking to the demo database. Please try again.";
}
