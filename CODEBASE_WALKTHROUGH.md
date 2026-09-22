# VoiceCare — Codebase Walkthrough

Plain-English, file-by-file tour of the code **as it actually is**. Everything below was
written by reading the source files themselves. If code and any other document ever
disagree, the code wins.

---

## 1. The big picture (30 seconds)

VoiceCare is a **monorepo** (one repository, two packages) managed with **pnpm workspaces**:

- **`packages/shared`** — the brain. Plain TypeScript: word lists, number parsing, validation
  rules, readback wording, and the voice-agent tool definitions. No database, no network.
- **`apps/web`** — a **Next.js** web app. Thin layer: API routes, a small browser UI, and the
  browser voice client. It imports the brain for every decision.

Data flows like this:

```
Caregiver speaks or types
        │
        ▼
Browser (records audio, shows text) ──► AssemblyAI (turns speech into words,
        │                                runs the voice agent, calls tools)
        │◄── tool calls ── forwards ──► Next.js API routes
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
            shared rules               PostgreSQL              confirm + save
         (is this complete?         (drafts, reports,        (only after the
          what is missing?)           sessions, memory)        caregiver confirms)
```

Golden rules the code enforces (you will see them everywhere below):

1. **The model proposes, the backend decides.** The voice agent never saves anything directly.
2. **Never guess a unit.** A missing unit is a question, not an assumption.
3. **Nothing saves without an explicit confirmation** tied to the exact revision shown.
4. **Identity comes from the server session, never from the model.** The agent is never told
   internal ids.

### Commands (from the root `package.json`)

- `corepack pnpm dev` — run the web app locally.
- `corepack pnpm build` — production build (also runs the type checker).
- `corepack pnpm lint` / `corepack pnpm typecheck` — code checks.
- `corepack pnpm test` — runs the shared-package tests (28 tests).

You need `Node.js 24+` and `corepack` enabled. Environment variables live in
`apps/web/.env.local` (see `apps/web/.env.example` for the list: AssemblyAI key, voice
timings, and the Neon database URLs).

---

## 2. The brain: `packages/shared`

Start here. Every important decision lives in these files, and the web app just calls them.

Its `package.json` exposes everything through `src/index.ts` (one line per module), tests run
with plain `node --test` on four test files, and TypeScript is strict.

### 2.1 `src/vocab.ts` — all the word lists in one place

Think of this as the dictionary the whole program shares, so the agent, the backend, the
browser, and the tests can never disagree about names.

- **Measurement types (5):** `blood_pressure`, `blood_glucose`, `temperature`, `heart_rate`,
  `oxygen_saturation`.
- **Allowed units per type:** blood pressure only `mmHg`; glucose `mmol/L` or `mg/dL`;
  temperature `°C` or `°F`; heart rate `bpm`; oxygen `%`. There are helpers like
  `isUnitForType(type, unit)` ("is °C a temperature unit?") and `isSingleUnitType`
  (true when a type has only one possible unit, so no question is ever needed).
- **Observation categories (6):** `pain`, `food_intake`, `mood`, `sleep`, `symptom`, `other`
  (a bucket for anything that does not fit, so statements are preserved, never forced).
- **Time labels:** statuses (`explicit`, `relative_resolved`, `report_default`, `unknown`)
  and precisions (`exact`, `morning`, … `assumed`, `unknown`).
- **Draft statuses (7):** `CAPTURING → DRAFT → NEEDS_CLARIFICATION → REVIEWABLE →`
  `CORRECTING → CONFIRMED → SAVED`. Only the backend may set the last two.
- **Issue codes (5):** `needs_unit`, `needs_value`, `needs_time`, `ambiguous`,
  `expression_permission`.
- **Which issues block saving:** `needs_unit`, `needs_value`, `ambiguous` — plus
  **not** `needs_time` and **not** `expression_permission`. This is a deliberate demo rule:
  the caregiver reports as things happen, so the recording moment stands in for an
  unstated time instead of interrogating them, and remembering a phrase never gates a report.
- **Spoken unit names** (`UNIT_SPEECH`): maps `mmHg` → "millimetres of mercury" etc., so the
  readback speaks units out loud.
- Small constants: demo sessions live 72 hours.

### 2.2 `src/ids.ts` — id generation

Ids look like `pat_a1b2…`, `draft_…`, `rep_…` (readable prefixes from `ID_PREFIXES`). Real
code passes a factory using random bytes; tests use `sequenceIdFactory()` (predictable
`prefix_0001`, `prefix_0002`, …).

### 2.3 `src/time.ts` — clocks, timezones, and phrases like "this morning"

- `wallClockInTimeZone` / `zonedTimeToUtc`: converts "8 in the morning in Berlin" into an
  exact UTC instant, correctly across daylight-saving changes (two-pass offset fix).
- `TIME_PHRASES`: a table mapping phrases to clock times — "this morning" → 08:00 today,
  "yesterday evening" → 19:00 yesterday, "just now"/"right now" → this instant, plus
  "today", "yesterday", "tonight", "last night", etc. Longest phrases match first, with word
  boundaries (so "today" never matches inside another word).
- `resolveTimePhrase`: turns a matched phrase into `{ observed_at, precision, status,
  source_text }`. The original words and the reduced precision ("morning", "day") are always
  kept alongside the instant.
- `precisionForSourceText`, `isValidTimeZone`, `formatInstant` (for display).

### 2.4 `src/numbers.ts` — turning spoken words into digits

`resolveSpokenNumbers(text)` scans text, gathers runs of number-words, and converts each run.
It understands digits (`one`…`nine`, `oh`/`o` = 0), teens, tens, scales (`hundred`,
`thousand`), decimals (`six point two` → `6.2`), and dashed compounds (`thirty-eight`).

Clever safety details:

- Runs only convert when they read as a number **on their own**. A lone "one"/"a"/"oh"
  stays a word (in normal speech those are articles, not measurements).
- Punctuation is its own token, so `"seventy—sorry, seventy-two"` does not merge into one
  giant number, while `"one hundred and thirty-eight"` still joins (the `and` between two
  number-words is kept, not treated as a separator).
- A single space continues a run; a line break ends it.

### 2.5 `src/schemas.ts` — the shapes of everything (validated with Zod)

Three layers, all in this one file:

1. **Stored shapes** (`measurementSchema`, `observationSchema`): exactly what sits in the
   database. Each item carries its value(s), `unit`, `unit_source` (spoken / patient_setting
   / default), its own time fields (`observed_at`, `time_precision`, `time_source_text`,
   `time_status`), the exact `source_text` supporting it, and a `resolution_status`
   (`resolved`, `needs_unit`, `needs_value`, `needs_time`, `ambiguous`). Blood pressure
   stores `systolic` + `diastolic` separately (order preserved); other types store `value`.
   Observations add `category`, `text`, `body_location`, `negated`.
2. **Agent input shapes** (`measurementInputSchema`, `observationInputSchema`): permissive —
   almost everything optional **except** `source_text` (the model's exact-words evidence is
   mandatory) and `type`/`category`. The agent may also flag itself `ambiguous` with a
   `clarification_question`.
3. **Tool + API payloads**: `updateDraftArgsSchema` (no `patient_id` — identity comes from
   the session, never the model), `askCaregiverArgsSchema`, `rememberExpressionArgsSchema`,
   `confirmPatientUnitArgsSchema`, `finishDraftArgsSchema`, plus `draftPatchSchema` (browser
   edits, with `expected_revision` + `reason`), `draftConfirmSchema`, `draftSaveSchema`
   (with `idempotency_key`), expression create/patch/record schemas, `reportRecordSchema`
   (with `superseded_by`/`supersedes` links), `healthResponseSchema`, `bootstrapResponseSchema`.

Also: `draftSnapshotSchema` (the exact content shown at one revision) and `draftRecordSchema`
(snapshot + readback text, confirmation fields, clarification trail, timestamps).

### 2.6 `src/questions.ts` — one wording per question, used everywhere

Single-sentence builders so the agent, browser, and API ask identically:
`unitQuestion` ("You said the blood glucose was 6.2. Does the device use mmol/L or mg/dL?"),
`unsupportedUnitQuestion`, `valueQuestion` (blood pressure asks for "both numbers, for
example 138 over 88"), `timeQuestion`, `ambiguityQuestion` ("I want to be sure I understood
"…". Can you say it another way?"), `expressionPermissionQuestion` ("Should I remember …?"),
and `unresolvedStatement` (summarises the blocking questions, counting the extras).

### 2.7 `src/resolve.ts` — the decision engine ("is this item complete?")

The only place that judges completeness. Key functions:

- **`resolveMeasurement(input, existing, ctx)`** merges a proposal with any existing item,
  then applies the **unit policy** in strict order: spoken unit → already-stored unit →
  confirmed patient/device setting → the type's single unit (e.g. mmHg, bpm). A
  plausible-looking value is **never** evidence for a unit. Outcomes: missing value →
  `needs_value`; missing/unsupported unit → `needs_unit` (unsupported units re-ask with the
  valid options, but only once a value exists — one question at a time); missing time →
  `needs_time`; agent-flagged doubt → `ambiguous`. Unusual values get a `warning` ("looks
  unusual… please double-check") but are **kept, never replaced**.
- **`resolveObservation`** does the same for symptoms/notes (time + ambiguity only).
- **`inheritTime`**: precedence is explicit provided time → previously stored time →
  report-level time (labelled `report_default`) → unknown. This is how "this morning" said
  once covers every item in the report.
- **`issuesFromResolvedItems`**: rebuilds all questions from scratch after every change, so
  questions can never go stale. (Expression-permission issues are handled separately.)
- **`deriveDraftStatus`**: empty → `CAPTURING`; any blocking issue → `NEEDS_CLARIFICATION`;
  otherwise `REVIEWABLE`.
- **`stableStringify` / `canonicalSnapshotString`**: deterministic serialisation so the
  report's content hash is stable — the foundation of duplicate-save protection.
- **`makeExpressionPermissionIssue`**: the "should I remember this phrase?" question shape.

### 2.8 `src/readback.ts` — what the caregiver hears and sees

`measurementSpokenPhrase` speaks every value **with its unit** ("blood glucose 6.2
millimoles per litre"), notes saved-setting units ("from your saved setting") and unusual
values ("please double-check it"). `buildReadback` assembles the full sentence: measurements
("I have …"), observations ("I also noted …"), the time ("The time was this morning." / an
assumed-time disclaimer), then either the first blocking issue or "Is that correct?".
**The same string is spoken, displayed, and printed** — they cannot diverge.
`buildDraftSummaryLines` renders the short written form.

### 2.9 `src/extract.ts` — the typed-fallback path (same rules, no microphone)

`extractCareReport(transcript, options)` turns a typed sentence into `MeasurementInput` /
`ObservationInput` objects that then flow through the **identical** backend rules, so typing
can never skip validation. How:

1. `splitClauses` splits on punctuation and and/but/then — **except** between number-words
   ("one hundred and thirty-eight" stays whole) and after correction words ("72, sorry, 74"
   stays one clause).
2. `resolveSpokenNumbers` digitises each clause; `applySelfCorrections` keeps only the
   corrected number ("37.2, not 37.4" → 37.2, with an audit note).
3. Each clause gets its time phrase resolved ("this morning" → instant + `morning`
   precision); the first one becomes the report-level time. No time stated → entry time
   offered as `assumed`.
4. Keyword matching per clause: measurement words (pressure/sugar/temp/heart/oxygen),
   spoken unit words ("millimoles" → `mmol/L`, "beats per minute" → `bpm`, …), then
   remembered personal expressions (only if no keyword matched **and** the sentence is not a
   symptom — so "her heart hurts" can never become a number). Blood pressure needs a "138
   over 88" (or "138/88") pair; a lone number is kept as systolic so the backend asks for
   the rest.
5. Observations: pain/food/mood/sleep/symptom keywords, body-part finder ("left knee"),
   negation detection ("no", "not", "none", …). Unmatched clauses starting with "I checked…"
   are skipped (talking about the visit, not an observation); other substantial unmatched
   text is kept as category `other` rather than dropped or invented. "Pain yesterday, but
   none today" becomes **two** time-qualified observations (negation preserved per period).

### 2.10 `src/tool-schema.ts` — generating the agent's tools

`AGENT_TOOLS` (update_draft, ask_caregiver, remember_expression, confirm_patient_unit,
finish_draft) with JSON Schema generated from the Zod schemas via `z.toJSONSchema` —
**generated, never retyped**, so the contract cannot drift. `formatValidationIssues` turns
schema errors into field-level messages ("measurements.0.source_text: Required") that help
the agent recover.

### 2.11 Tests

`numbers.test.ts`, `resolve.test.ts`, `extract.test.ts`, `readback.test.ts` — 28 tests
covering the demo sentence end to end, self-corrections, negation across days, learned
expressions (and the "heart hurts" guard), unsupported statements staying free text, silent
unit assignments being refused, and snapshot-hash stability.

---

## 3. The web app: `apps/web`

Next.js (App Router) + React + TypeScript. Config notes:

- `next.config.ts`: `transpilePackages: ["@voicecare/shared"]` — the shared package ships
  TypeScript source (single source of truth), so Next.js compiles it.
- `tsconfig.json`: includes `allowImportingTsExtensions` for those `.ts` imports.
- `.env.example` lists every variable: server-only `ASSEMBLYAI_API_KEY`, token/session
  timings, `VOICE_AGENT_VOICE` (default `alba`), pooled `DATABASE_URL` and direct
  `DATABASE_URL_UNPOOLED`.

### 3.1 Small libraries

- **`src/lib/db.ts`** — one cached Neon serverless client (`getSql()`), `pingDatabase()`
  for health/warmup, and `friendlyDatabaseMessage()` (**provider errors and stack traces
  stay in the server log; the browser only ever sees a friendly retry sentence**).
- **`src/lib/http.ts`** — `ApiError(status, code, message, draft?)`, `jsonOk`/`jsonError`
  envelopes, `readJson`/`parseWith` (Zod-validated bodies), and `handle()` which converts
  any throw into a safe JSON error. `parseDateRange` parses summary filters.
- **`src/lib/session.ts`** — anonymous demo sessions. The browser holds one random opaque
  token in an `HttpOnly`, `Secure` (production), `SameSite=Lax` cookie; the database stores
  only its SHA-256 hash. `bootstrapSession` creates-or-restores a session plus one fictional
  caregiver ("Demo caregiver") and patient ("Rosa") with sliding 72 h expiry;
  `resetSession` invalidates the old session and issues a clean one; `requireSession`
  rejects unknown/expired sessions (and carefully preserves the stored timezone instead of
  overwriting it). **Every read/write is scoped to the caregiver from the cookie** — ids
  sent by the browser never establish ownership.
- **`src/lib/bootstrap.ts`** — builds the home-screen payload: session, caregiver,
  patients, current draft, expressions, report count.

### 3.2 `src/lib/drafts.ts` — the draft lifecycle (the heart of the backend)

- **Reading:** `snapshotFromRow` / `recordFromRow` parse the `jsonb` columns back through
  the shared schemas (unreadable data → explicit error, never silent garbage) and attach
  the readback sentence plus the unresolved-issues summary. `findDraftRow` scopes by
  caregiver; stale/missing drafts 404.
- **Creating:** `createDraft` inserts draft + first revision row together in one batch.
- **Changing (`applyDraftChange`)** — every change carries `expected_revision`; a mismatch
  changes nothing and returns the latest draft (HTTP 409). Steps: resolve the **incoming
  report time first** so items in the same call inherit it; match each proposed item to an
  existing one (by id, else the single same-type measurement, else matching observation
  text); resolve via shared rules; rebuild all questions; bump revision; **clear any
  confirmation**; write the draft update + new revision row in one guarded batch. A
  clarification audit log records each question and marks it answered when its issue closes.
- **Confirming (`confirmDraftRevision`)**: only from a matching revision, only when no
  **blocking** issue remains and status is reviewable-ish; a guarded `UPDATE` prevents
  confirmation racing a concurrent edit.
- **Saving (`saveConfirmedDraft`)** — idempotent, in this order: (1) look up the
  `idempotency_key`: known key + same content → return the existing report (`reused:
  true`); known key + different content → 409 (a key binds to exactly one report);
  (2) otherwise require `CONFIRMED`, insert the report as an **immutable snapshot** of the
  confirmed revision **only if** the draft is still CONFIRMED at that revision, then move
  the draft to `SAVED` pointing at the new report — one non-interactive batch, guarded at
  every step so a stale confirmation can never orphan a report. A later correction creates
  a new revision and a new report; the old one stays as the superseded record.

### 3.3 `src/lib/expressions.ts` and `src/lib/reports.ts`

- **Expressions:** list/create/correct/soft-delete remembered phrases, caregiver-scoped,
  one active entry per phrase/scope (repeats → 409 "already remembered"). Stored meanings
  are validated measurement types + optional unit.
- **Reports:** history lists **current** reports only (one observation appears exactly
  once); detail resolves the supersede chain (earlier/later revision links); summary
  returns the same set chronologically for printing. Date filters use observation time,
  falling back to entry time.

### 3.4 `src/lib/voice.ts` — AssemblyAI session support (server side)

- `mintVoiceToken()`: `GET https://agents.assemblyai.com/v1/token` with
  `expires_in_seconds` (redemption window, default 120 s) and
  `max_session_duration_seconds` (default 600 s), key in the `Authorization` header.
  Single-use tokens, fetched fresh per connection. Every failure maps to a speakable
  "use the typed fallback" message.
- `buildSystemPrompt(...)`: role + timezone + confirmed device units + remembered
  expressions (each annotated "only when the sentence is about a measurement") + rules
  (send exact-words `source_text`; never infer units; one question at a time; read back
  `finish_draft` verbatim; **never claim anything is saved**; no diagnosis; emergencies →
  local emergency services).
- Transcription biasing: `transcription_prompt` (numbers, corrections, units, body parts,
  time phrases) + `keyterms` (measurement words, patient name, remembered phrases, ≤50).
- Session tuning for the demo: `transcription_mode: "min_latency"`, English only, silence
  window 700/1500 ms with barge-in allowed, voice `alba`, PCM audio both directions.
  (Latency/accuracy trade-off is stated in the file: misheard numbers stay safe because of
  readback + explicit confirmation.)

### 3.5 `src/lib/agent-tools.ts` — the five tools, executed server-side

`handleAgentTool` dispatches; `parseToolArgs` validates against the shared schemas and, on
failure, reports **every** problem at once (plus a server-log line with the raw args) so
the agent recovers in one retry:

- **update_draft** → `applyDraftChange` as `agent_update`; returns compact result
  (revision, status, blocking questions, readback).
- **ask_caregiver** → logs the question (building the permission wording for
  `expression` kind) as `agent_update` without touching items.
- **remember_expression** → stores only after explicit yes (`confirmed_by_caregiver`),
  closes the matching permission issue + audit entry; "already remembered" is a note, not
  an error; no closes the question and stores nothing.
- **confirm_patient_unit** → requires the caregiver's confirmation first, validates the
  unit, optionally persists it to the patient's `preferred_units` (`jsonb` merge), and
  applies it to the referenced measurement keeping spoken values.
- **finish_draft** → read-only: returns readback, `can_save`, and the next step ("read the
  readback word for word" vs "ask the first blocking question").
- Plus `submitTypedObservation`: typed text → local `extractCareReport` → the same
  `applyDraftChange` path, so typing can never bypass a rule.

### 3.6 API routes (`src/app/api/.../route.ts`, 16 total)

| Route | What it does |
|---|---|
| `GET /api/bootstrap?timezone=` | Create/restore demo session + fictional patient; home-screen payload |
| `POST /api/reset` | Abandon workspace, issue a clean isolated session |
| `GET /api/health` | App + database + voice readiness, no secrets |
| `POST /api/voice/token?patient_id=` | Mint token, warm the DB, return token + session config |
| `POST /api/drafts` | Start a draft for the selected patient |
| `GET /api/drafts/:id` | Load a draft |
| `PATCH /api/drafts/:id` | Caregiver correction (revision-guarded, clears confirmation) |
| `POST /api/drafts/:id/tool` | Browser forwards one agent tool call; validates + executes |
| `POST /api/drafts/:id/text` | Typed-observation intake |
| `POST /api/drafts/:id/confirm` | Explicit confirmation of the current revision |
| `POST /api/drafts/:id/save` | Idempotent save → returns report + `reused` flag |
| `GET /api/reports?patient_id=&from=&to=` | Current-report history |
| `GET /api/reports/:id` | Full report incl. superseded chain |
| `GET /api/reports/summary` | Chronological summary + caregiver-reported disclaimer |
| `GET/POST /api/expressions`, `PATCH/DELETE /api/expressions/:id` | Remembered-phrase management |

Every route (except the minimal health check) resolves the session server-side; dynamic
routes await their params (Next.js 16 pattern).

### 3.7 `src/hooks/use-voice.ts` — the browser voice client, step by step

1. Tap Speak → open/create a draft (tool calls need a home) → mic permission
   (`echoCancellation` on, `noiseSuppression` off — the server already denoises).
2. `POST /api/voice/token` → single-use token + session config.
3. `new AudioContext()` at the **device rate** (deliberately — only the default graph feeds
   every browser's echo canceller) + `/pcm-processor.js` worklet with the real rates.
4. Open `wss://agents.assemblyai.com/v1/ws?token=…`, send one `session.update`
   (`system_prompt`, `tools`, `output`, `input` — no greeting, so the session opens silently).
5. On `session.ready`: save `session_id` (for resume) and **verify** the echoed config shows
   the transcription prompt applied (`verified` flag).
6. Stream mic PCM (worklet → base64 `input.audio`) only while ready + socket open; play
   `reply.audio` chunks chained on a playback clock (the context resamples to device rate
   on output); render `transcript.user`/`transcript.agent` lines plus live partials
   (deltas **replace** per item, never concatenate).
7. `tool.call` → POST to our tool endpoint with the draft's current revision injected →
   queue the result → send `tool.result` **only** when `reply.done` is latest (interrupted
   turns drop theirs; anything older than 90 s expires). Backend errors go back with
   `is_error: true` and a speakable message; a `stale_revision` rejection retries **once**
   at the fresh revision automatically.
8. Status line mirrors the session (`requesting-mic → connecting → ready → listening →
   processing → Thinking…` on speech end); every event emits one quiet
   `console.debug("[voicecare:voice]", …)` line, including tool POST outcomes — a stuck
   call shows exactly where it stopped.
9. Drops resume **once** via `session.resume` (fresh token) inside the 30 s grace window;
   Stop / page-hide sends `session.end` first so nothing billable lingers.

### 3.8 `public/pcm-processor.js` — the resampler in plain words

An `AudioWorklet` that receives microphone samples at the device rate, walks them with a
fractional position (`position += inputRate / 24000`), linearly interpolates between
neighbouring samples, emits 16-bit integers, and carries the leftover fraction into the
next chunk so long sessions never drift.

### 3.9 `src/components/demo-app.tsx` — the minimal UI

Two views, nothing else:

- **Home:** big round **Speak/Stop** button, one-line status, a scrolling conversation space
  (lines + live partials + the to-confirm readback), tappable unit-option answers (the
  typed-only path to answering), a single green **Confirm and save** card when reviewable
  (with Retry after confirmation), a quiet **Type instead** toggle, and **History** /
  **Reset** buttons. Notices appear inline; the footer states the fictional-data prototype
  boundary.
- **History:** saved reports (newest first), detail with original wording and
  earlier/newer revision links, date-filtered printable appointment summary (print CSS
  isolates `#print-summary`), remembered phrases with Forget.
- Wiring: `ensureDraft`, `answerIssue` (unit taps patch the stored item keeping spoken
  values; expression answers store-or-skip then resolve the issue), `confirmAndSave`
  (confirm → save with a fresh UUID key per revision; retries reuse it), `resetDemo`.

`src/app/page.tsx` renders it; `layout.tsx` sets title/metadata; `globals.css` is Tailwind
plus the print isolation rules.

---

## 4. The database: `apps/web/db/schema.sql` (PostgreSQL on Neon)

Applied with `psql "$DATABASE_URL_UNPOOLED" -f db/schema.sql` (the server reads the pooled
`DATABASE_URL`; Next.js loads env from `apps/web/.env.local`, never the repo root).

- **`demo_sessions`** — `id`, `token_hash` (unique; only the hash is stored), expiry,
  invalidation, timestamps. The authorisation boundary.
- **`caregivers`** — one fictional profile per session (unique per session), display name,
  timezone.
- **`patients`** — id + caregiver, display name, `preferred_units` (`jsonb`, e.g.
  `{"blood_glucose": "mmol/L"}`). Composite keys tie every patient to its caregiver.
- **`drafts`** — the lifecycle row: patient/caregiver, `revision`, `status`
  (check-constrained to the 7 states), transcript, report-level time (+precision/source),
  `measurements`/`observations`/`unresolved_issues`/`clarification_log` as `jsonb`,
  confirmation triple (`confirmed_revision`/`confirmation_method`/`confirmed_at`, all or
  nothing), `current_report_id`. Hard rules as constraints: confirmation must equal the
  current revision; patient must belong to the draft's caregiver.
- **`draft_revisions`** — one row per change (`draft_id`, `revision` unique pair, status,
  full `snapshot`, `reason`).
- **`reports`** — immutable snapshots: unique `idempotency_key`, unique
  `(draft_id, confirmed_revision)` (one revision → one report, retries converge), content
  hash binding key to content, FKs tying report/draft/patient/caregiver together plus a FK
  into the revision trail (a report must reference a revision that actually happened). A
  **trigger rejects every UPDATE/DELETE** — corrections are new reports; the draft pointer
  moves and the old report stays as the superseded record.
- **`personal_expressions`** — caregiver (+optional patient) scope, phrase, normalised
  meaning, context, confirmation date; soft delete; unique active phrase per scope.
- No seed data: bootstrap creates the fictional rows per browser. Serverless-friendly:
  single statements plus one two-statement batched save (insert report, then move pointer).

---

## 5. End-to-end trace: the demo sentence through every layer

Input (typed or spoken): *"I checked Rosa this morning. Her pressure was 138 over 88, her
sugar was 6.2, temperature 37.4, and her left knee was hurting."*

1. **Extract/Hook:** typed → `extractCareReport` (clauses, corrections, "this morning" →
   08:00 `morning` report time, BP pair, glucose 6.2 unit-less, temp 37.4 unit-less, left-knee
   pain observation); voice → agent `update_draft` tool calls forwarded to the same backend.
2. **Resolve:** BP complete (mmHg is its only unit, time inherited as `report_default`);
   glucose + temp → `needs_unit` (blocking); pain resolved. Times inherited everywhere, so
   **no time questions**. Draft: revision 2, `NEEDS_CLARIFICATION`.
3. **Ask:** "Does the device use mmol/L or mg/dL?" → answer `mmol/L`; same for °C. Each
   answer is a revision-guarded change that clears confirmation.
4. **Review:** readback with spoken units + "Is that correct?" → status `REVIEWABLE`.
5. **Confirm:** explicit button → `CONFIRMED` at revision 4.
6. **Save:** idempotent insert + pointer move → one report; a retried POST returns it with
   `reused: true`. History shows it once; summary prints it; reset wipes the workspace.

---

## 6. When something breaks (from the code's own error paths)

- **`400 invalid_tool_arguments`** — the agent sent a bad field; the message lists every
  problem (`tool: field: reason…`), the browser trace shows the HTTP status, and the dev
  terminal logs the raw args (`[voicecare] tool arguments rejected`). Fix fields, retry
  same revision.
- **`409 stale_revision`** — the draft moved under you; the response carries the latest
  draft; reload and act on it (the voice client retries once automatically).
- **`409 unresolved_items` / `not_reviewable`** — blocking questions remain; answer them.
- **`409 not_confirmed`** — save before confirmation; confirm first.
- **`409 idempotency_key_reused`** — same key, different content; confirm again for a fresh key.
- **`401 session_required/expired`** — reload recreates the session via bootstrap.
- **404 `draft/report/expression_not_found`** — id outside this browser's session (e.g. a
  hallucinated id — which is why the agent is never given any).
- **Voice-specific:** no `session.ready` → token/session problem (check terminal token
  logs); transcript but no reply → watch the `[voicecare:voice]` event lines to see the
  stall (tool call → result → flush); garbled audio → device-rate issue (the worklet path
  handles it — check `audioCtx.sampleRate` vs 24000 assumptions nowhere remain).

---

## 7. File map (where to look)

- Decision logic: `packages/shared/src/` — `vocab` (words) → `schemas` (shapes) →
  `resolve` (judgements) → `readback`/`questions` (wording) → `extract` (typing path) →
  `tool-schema` (agent tools). `numbers` + `time` are the parsing basement.
- Server state: `apps/web/src/lib/` — `session` (who) → `drafts` (lifecycle) →
  `agent-tools` (tools) → `reports`/`expressions` (reads/writes) → `voice` (session
  config) → `db`/`http`/`bootstrap` (plumbing).
- Wire: `apps/web/src/app/api/` (16 routes) → `apps/web/src/hooks/use-voice.ts` (socket)
  → `apps/web/src/components/demo-app.tsx` (screen) → `apps/web/db/schema.sql` (tables).

Total: ~30 source files plus tests. The shared package decides; the web app transports;
the database remembers; the caregiver confirms.
