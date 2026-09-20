# Segment 5: Data and Technical Architecture

## Proposed architecture

```text
Browser UI
  ├─ microphone capture and audio playback
  ├─ visible draft and corrections
  └─ history and printable summary
          │
VoiceCare backend
  ├─ authentication and patient context
  ├─ temporary AssemblyAI token endpoint
  ├─ draft validator and confirmation state
  ├─ idempotent report save
  └─ vocabulary retrieval and management
          │
  ┌───────┴────────┐
AssemblyAI       Database
Voice Agent      reports, drafts,
API              settings, expressions
```

## Core entities

### Caregiver

- `id`
- `display_name`
- `timezone`
- `created_at`

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

### Confirmed report

- `id`
- `draft_id`
- `confirmed_revision`
- `confirmation_method`
- `confirmed_at`
- `idempotency_key`
- Immutable snapshot of the confirmed draft fields.

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

## API boundaries

Suggested application endpoints:

- `POST /api/voice/token` — issue a short-lived browser token.
- `POST /api/drafts` — create a session draft.
- `PATCH /api/drafts/:id` — validate and apply a draft revision.
- `POST /api/drafts/:id/confirm` — confirm a specific revision.
- `POST /api/drafts/:id/save` — idempotently save the confirmed revision.
- `GET /api/reports` — list confirmed reports for a patient and date range.
- `GET /api/reports/:id` — retrieve a report.
- `GET /api/reports/summary` — render summary data for printing.
- `GET /api/expressions` — list remembered expressions.
- `POST /api/expressions` — store a separately approved expression.
- `PATCH /api/expressions/:id` — correct an expression.
- `DELETE /api/expressions/:id` — delete an expression.

## Validation rules

- Identifiers supplied by the voice agent must match the authenticated session context.
- Numeric values must be finite and valid for their field shape.
- Validation may flag unusual values but must not silently replace them.
- Enumerated types and units must use supported values.
- Source text is required for AI-extracted fields.
- A saved report must reference one exact confirmed draft revision.
- The idempotency key must be unique per intended save.

## AssemblyAI integration

- The backend stores the AssemblyAI API key.
- The browser requests a temporary token immediately before connecting.
- The session supplies a concise system prompt, transcription context, relevant key terms, and tool definitions.
- Tool calls update a server-side draft; they do not directly create confirmed reports.
- The application records the AssemblyAI session ID for troubleshooting and retention management.
- Voice Agent session artifacts are treated as separate from VoiceCare's confirmed report data.

## Prototype technology choices

The implementation can use a React-based web client, a small Node.js API, and a relational database. Exact framework choices remain implementation decisions as long as the boundaries and invariants above are preserved.

