# Segment 5: Data and Technical Architecture

## Proposed architecture

```text
Browser UI
  ├─ anonymous secure session cookie
  ├─ patient switcher (select / add)
  ├─ Stage 1: mic capture + live medical captions + Done (text fallback)
  ├─ Stage 2: agent conversation, visible draft and corrections
  └─ history, doctor / family / file exports, and demo reset
          │
VoiceCare backend
  ├─ demo-session isolation and fictional patient context
  ├─ bootstrap, reset, patients, and health endpoints
  ├─ streaming-token + voice-token endpoints (single-use, server-side key)
  ├─ draft validator and confirmation state
  ├─ idempotent report save
  └─ vocabulary retrieval and management
          │
  ┌────────┴─────────┐
AssemblyAI         Database
Streaming STT      reports, drafts,
(medical-v1)       patients, settings,
+ Voice Agent      expressions
API
```

## Core entities

### Demo session

- `id`
- `token_hash` — hash of the random opaque token held in the browser's secure cookie
- `expires_at`
- `invalidated_at`
- `created_at`
- `last_seen_at`

The demo session is the authorization boundary for the hosted prototype. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`,
and scoped to the application path. The backend resolves the caregiver from this cookie; it never trusts a caregiver identifier
sent by the browser or voice agent. A reset invalidates the old session and issues a new one. A session and its fictional records
may expire after 72 hours.

### Caregiver

- `id`
- `demo_session_id`
- `display_name`
- `timezone`
- `created_at`

For the hackathon, this is a fictional caregiver profile owned by one demo session, not a registered account.

### Patient

- `id`
- `caregiver_id`
- `display_name`
- `preferred_units`
- `created_at`

The prototype should avoid collecting demographics that are not required for the demo.

### Report draft

- `id`
- `patient_id`
- `caregiver_id`
- `session_id`
- `revision`
- `status`
- `original_transcript`
- `observation_time`
- `observation_time_precision`
- `entry_time`
- `measurements`
- `observations`
- `unresolved_issues`
- `created_at`
- `updated_at`

`observation_time` is the report-wide default. Each measurement and observation also carries its own time fields so one spoken
report can accurately represent events from different periods.

### Draft revision

- `id`
- `draft_id`
- `revision`
- `status`
- `snapshot` — the exact content the caregiver heard and saw at that revision
- `reason` — agent update, clarification answer, caregiver correction, or post-review correction
- `created_at`

The draft and its first revision are written together, and every later draft-changing event adds one row. A revision therefore
always exists before a report can reference it, which keeps the stored record identical to what was read back (FR-040).

### Confirmed report

- `id`
- `draft_id`
- `confirmed_revision` — must also exist in the draft's revision trail
- `confirmation_method`
- `confirmed_at`
- `idempotency_key`
- `content_hash` — binds the idempotency key to the exact intended report content
- Immutable snapshot of the confirmed draft fields.
- Append-only: the database rejects updates and deletes.

`drafts.current_report_id` points at the draft's current report. Saving a later confirmed revision moves the pointer, so the
earlier report remains as the superseded record instead of a duplicate or an edit.

### Personal expression

- `id`
- `caregiver_id`
- `patient_id` when patient-specific
- `phrase`
- `normalized_meaning`
- `context_constraints`
- `confirmed_at`
- `updated_at`
- `deleted_at`

## Shared structured-data contract

The source of truth for measurements and observations lives in `packages/shared` and is used to generate or validate the voice
tool schema, backend inputs, frontend types, and test fixtures. PostgreSQL stores the validated objects as `jsonb` so the
prototype can support several measurement shapes without a table per type.

Every measurement and observation contains:

- An application-generated `id`.
- Its type or category and structured value fields.
- `observed_at` when an instant can be resolved.
- `time_precision` and the caregiver's `time_source_text`.
- `time_status`: `explicit`, `relative_resolved`, `report_default`, or `unknown`.
- The exact `source_text` supporting the extracted information.
- `resolution_status`: `resolved`, `needs_unit`, `needs_value`, `needs_time`, or `ambiguous`.

Blood pressure preserves `systolic` and `diastolic` separately. Other numeric measurements contain `value` and `unit`.
Observations may contain category, text, body location, negation, and other fields defined by the shared schema. Unknown fields
remain unknown; they are not silently replaced with plausible defaults. Confirmation belongs to the complete draft revision,
while `resolution_status` describes whether an individual item is ready for review.

## API boundaries

Suggested application endpoints:

- `GET /api/bootstrap` — create or restore the browser's anonymous demo session and fictional patients.
- `POST /api/reset` — abandon the current demo workspace and issue a clean isolated session.
- `GET /api/health` — report application and database readiness without exposing secrets or sensitive details.
- `POST /api/patients` — create a patient scoped to the demo-session caregiver.
- `POST /api/voice/streaming-token` — issue a single-use Stage 1 token plus the medical-v1 streaming config.
- `POST /api/voice/token` — issue a single-use Stage 2 Voice Agent token plus the session config.
- `POST /api/voice/transcribe` — Stage 1 fallback: transcribe the backup blob with the medical domain.
- `POST /api/drafts` — create a session draft.
- `GET /api/drafts?patient_id=` — current draft for one patient (powers switching).
- `PATCH /api/drafts/:id` — validate and apply a change only when `expected_revision` matches, then increment the revision and clear any confirmation.
- `POST /api/drafts/:id/confirm` — confirm the draft's current revision; rejected when the draft is not reviewable.
- `POST /api/drafts/:id/save` — idempotently save the confirmed revision and move `current_report_id`.
- `GET /api/reports` — list current confirmed reports for a patient and date range.
- `GET /api/reports/:id` — retrieve a report, including the revisions it superseded.
- `GET /api/reports/summary` — summary data backing all three exports (rendered deterministically client-side, no LLM).
- `GET /api/expressions` — list remembered expressions.
- `POST /api/expressions` — store a separately approved expression.
- `PATCH /api/expressions/:id` — correct an expression.
- `DELETE /api/expressions/:id` — delete an expression.

Every endpoint except the minimal health response resolves the demo session on the server and scopes its database operation to
that session's caregiver. A missing or expired session is renewed through bootstrap. A stale draft update returns `409 Conflict`
with the latest revision so the client can reload it.

## Save and amendment flow

1. The backend marks the draft reviewable only when no required field is unresolved.
2. Confirmation records the method and time and binds them to the current revision. Anything that changes the draft
   afterwards increments the revision and clears the confirmation, which the database enforces.
3. Saving runs one non-interactive batched transaction in a fixed order: insert the report as an immutable snapshot of the
   confirmed revision, then set the draft to `SAVED` and point `current_report_id` at that report. The order matters because
   the pointer references the new row.
4. A repeated save with the same idempotency key inserts nothing, and the client reads the existing report instead (FR-044 and
   the save-uncertainty rule in Segment 6).
   Reusing that key for different draft content is rejected. The unique `(draft_id, confirmed_revision)` pair is the final
   guarantee that one confirmed revision produces one report.
5. A correction after saving increments the revision and requires confirmation again. The next save repeats the same two
   statements, so the pointer moves and the earlier report stays in place as the superseded record.
6. History and all three exports read current reports, so one observation appears exactly once.

## Validation rules

- The backend derives the caregiver from the demo-session cookie and rejects patient, draft, report, or expression identifiers outside it.
- Every draft-changing request supplies `expected_revision`; a mismatch changes nothing and returns the latest draft.
- Numeric values must be finite and valid for their field shape.
- Validation may flag unusual values but must not silently replace them.
- Enumerated types and units must use supported values.
- Source text is required for AI-extracted fields.
- A confirmation must reference the draft's current revision; changing the revision invalidates it.
- A saved report must reference one exact confirmed draft revision that exists in the revision trail.
- The idempotency key must be unique per intended save.
- A draft has at most one current report; a later confirmed revision supersedes the earlier report without deleting it.
- Measurements and observations must pass the shared schema, including their per-item time and resolution fields.

## AssemblyAI integration

- The backend stores the AssemblyAI API key; the browser uses single-use tokens only.
- Stage 1: the browser opens Streaming STT with the medical domain (`universal-3-5-pro`, `medical-v1`, caregiver key terms, 800/3600 ms turn tuning). Finals accumulate visibly; Done sends `Terminate`. The backup blob plus async transcription (same domain) covers streaming failures.
- Stage 2: the browser opens the Voice Agent with a concise system prompt, transcription context, relevant key terms, and tool definitions; the Stage 1 transcript is injected and clarified turn-by-turn.
- Tool calls update a server-side draft; they do not directly create confirmed reports.
- The application records the AssemblyAI session IDs for troubleshooting and retention management.
- Streaming and Voice Agent session artifacts are treated as separate from VoiceCare's confirmed report data.

## Database decision

The prototype uses PostgreSQL hosted on Neon, provisioned through the Vercel Marketplace. This was previously left unspecified
while several requirements depend on relational guarantees: one report per intended save, one current report per draft,
a revision trail inside a draft, demo-session isolation, and caregiver-scoped reads.

Why PostgreSQL fits the invariants:

- `reports.idempotency_key` is unique, so a repeated save cannot create a duplicate report (FR-044).
- `reports` is unique on `(draft_id, confirmed_revision)`, so a report references exactly one confirmed revision.
- A trigger rejects `UPDATE` and `DELETE` on `reports`, keeping the confirmed snapshot immutable.
- `drafts.status` is constrained to the state machine in Segment 4, and every draft-changing event adds a `draft_revisions` row.
- `jsonb` stores measurements, observations, unresolved issues, and configured units without a migration per measurement type.
- Every application read and write is scoped by the caregiver resolved from the anonymous demo session. Cross-session isolation
  is covered by integration tests. Row-level security and registered accounts are outside the hackathon scope.

Deployment notes for the current Free plan, to be rechecked against the provider dashboard before submission:

- Compute suspends after five minutes of inactivity and scale-to-zero cannot be disabled on Free. The first query after a
  suspension pays a resume cost, and tool calls happen inside a spoken turn, so the app warms the connection when a session
  opens and a paid plan can disable scale-to-zero for the demo.
- Free includes 0.5 GB storage, 100 compute-hours per project, 5 GB of network transfer, and a six-hour restore window.
  VoiceCare stores text and `jsonb` only, and original audio is never copied into the database (Segment 6).
- The demo uses fictional information only. Production compliance plans, contracts, and real patient data are outside scope.
- The database region shall match the application's serverless function region so tool calls do not cross regions.

Connection rules:

- The Vercel Marketplace Neon integration injects `DATABASE_URL` (pooled by PgBouncer) and `DATABASE_URL_UNPOOLED`, plus
  `PGHOST`, `PGUSER`, `PGDATABASE`, and `PGPASSWORD`. Legacy `POSTGRES_*` variables exist for older templates.
- Server code reads `DATABASE_URL`. Local development uses `apps/web/.env.local`, which Next.js loads; a repository-root `.env`
  is not read by the application.
- The serverless driver's HTTP mode runs one statement per request and supports non-interactive batched transactions. The save
  path is therefore one batched transaction of two ordered statements, insert the report then move the draft's
  `current_report_id`, so no interactive transaction is required.
- The DDL lives in `apps/web/db/schema.sql`.

Alternative considered: a file-backed store was rejected because idempotency, revision uniqueness, and scoped history are
exactly what a relational database enforces, and because the hosted demo needs durability across restarts. SQLite was rejected
because serverless hosting has no persistent local file system. The DDL is provider-neutral, so any PostgreSQL host works.

## Prototype technology choices

The planned implementation uses a Next.js web client and route handlers, shared TypeScript validation schemas, and PostgreSQL.
The hackathon architecture deliberately excludes registered accounts, production healthcare compliance, clinician roles, EHR
integration, and enterprise operations. Its goal is a reliable deployed flow that an unknown remote judge can complete without help.
