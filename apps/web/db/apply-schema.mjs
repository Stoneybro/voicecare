// Applies db/schema.sql to the Neon database from a machine without psql.
//
// Usage (from apps/web): corepack pnpm db:apply
//
// Prefers DATABASE_URL_UNPOOLED (direct connection, for schema changes) and falls back to
// DATABASE_URL. Both are read from apps/web/.env.local, the file Next.js loads in development.
// The whole script runs as one simple-query round trip, which Postgres executes
// statement by statement; the DO $$ blocks need this because they contain internal semicolons.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, neonConfig } from "@neondatabase/serverless";

const here = path.dirname(fileURLToPath(import.meta.url));

const envText = await readFile(path.join(here, "..", ".env.local"), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!match) continue;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  env[match[1]] = value;
}

const connectionString = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set in apps/web/.env.local");
  process.exit(1);
}

// Node 24 ships a global WebSocket, which is all the driver needs to open its connection.
if (typeof WebSocket !== "undefined" && !neonConfig.webSocketConstructor) {
  neonConfig.webSocketConstructor = WebSocket;
}

const script = await readFile(path.join(here, "schema.sql"), "utf8");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query(script);
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  console.log("schema applied. tables:", rows.map((row) => row.table_name).join(", "));
} finally {
  await client.end();
}
