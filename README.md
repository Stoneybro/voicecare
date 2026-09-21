# VoiceCare

VoiceCare is a voice-first care documentation prototype for the AssemblyAI Voice Agent Hackathon.

The deployed hackathon build is designed for unattended remote judging. It uses fictional information and automatically creates
an anonymous, browser-scoped demo session, so judges do not register or sign in and cannot see another browser's demo records.

## Workspace

- `apps/web` — Next.js web application
- `apps/web/db/schema.sql` — PostgreSQL schema for the prototype
- `packages/shared` — reserved for shared schemas and types
- `spec` — segmented product specification

## Requirements

- Node.js 24 or newer
- Corepack

## Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill it in. Next.js loads env files from
`apps/web`, so the repository-root `.env` is not read by the application.

- `ASSEMBLYAI_API_KEY` — server-side only, used to mint single-use browser tokens. Never expose it to the client.
- `DATABASE_URL` — pooled Neon connection string used by the serverless driver.
- `DATABASE_URL_UNPOOLED` — direct connection string, used for schema changes.

## Database

The prototype uses PostgreSQL on Neon. The Vercel Marketplace Neon integration injects the connection
variables on deployments; for local development copy them from the Neon console. Apply the schema from
`apps/web`:

```bash
psql "$DATABASE_URL_UNPOOLED" -f db/schema.sql
```

The schema enforces the product invariants: isolated anonymous demo sessions, caregiver ownership,
a unique idempotency key and content hash per save, an append-only report table, one current report
per draft, and a draft revision trail. Fictional caregivers and patients are created by the bootstrap
endpoint rather than shared seed rows.

## Commands

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
```

The repository pins its pnpm version through the root `package.json`.
