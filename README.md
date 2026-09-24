# VoiceCare

VoiceCare is a voice-first care documentation prototype for the AssemblyAI Voice Agent Hackathon: caregivers of chronic patients record observations between appointments as naturally as a voice note, and those observations become structured data for medical personnel and the whole care circle.

Two AssemblyAI stages do the work. **Stage 1** records the voice note with live medical transcription (Streaming STT, `medical-v1`) and stays silent until the caregiver taps Done. **Stage 2** has the VoiceCare agent (Voice Agent API, turn-based) ask for whatever is missing or ambiguous. A personal phrase clarified once can be remembered with permission, so the system never asks twice. Confirmed reports export three ways from the same data: a structured doctor summary, a plain-language family summary, and JSON/CSV files for continuing care.

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
