# Segment 2: Development Stages

> Stack: Next.js 16 · React 19 · Tailwind 4 · Neon Postgres · AssemblyAI (Streaming STT + Voice Agent API)

The schema is already designed. The app shell is a blank Next.js scaffold. Everything below is net-new UI and API work, ordered so each stage produces something runnable and demo-able on its own.

---

## Stage 1 — Shell, Session & Workspace Bootstrap

**Goal:** A first-time visitor gets a working demo workspace in under 3 seconds, with no login.

| # | What | Detail |
|---|------|--------|
| 1.1 | Design system | `globals.css` — color tokens, typography (Inter), spacing, component primitives |
| 1.2 | Home screen layout | Hero + "Start recording" CTA, patient switcher, history list (empty state) |
| 1.3 | `GET /api/bootstrap` | Creates `demo_session`, fictional caregiver, and two fictional patients in one DB transaction; sets a `session` cookie |
| 1.4 | Session middleware | Every request resolves caregiver from cookie; rejects expired/invalid sessions cleanly |
| 1.5 | Patient switcher | Dropdown on home — lists patients scoped to session, persists selected in `localStorage` |
| 1.6 | `POST /api/patients` | Create a new patient in the session workspace |
| 1.7 | Demo reset | "Reset workspace" button calls `DELETE /api/demo` — wipes caregiver data, re-bootstraps |

**Exit criteria:** Open the app cold → workspace appears with two patients, no errors, no login.

---

## Stage 2 — Stage 1 Voice: Recording + Live Transcription

**Goal:** Caregiver taps record, speaks freely, sees live transcript, taps Done.

| # | What | Detail |
|---|------|--------|
| 2.1 | `GET /api/stt-token` | Mints a single-use AssemblyAI Streaming STT token (server-side key, never exposed) |
| 2.2 | Recording screen | Full-screen recording UI: animated waveform, live transcript panel, Done button |
| 2.3 | AssemblyAI Streaming STT | `medical-v1` model, WebSocket connection; partial + final transcript stitched in real-time |
| 2.4 | `POST /api/drafts` | Creates a `CAPTURING` draft for the selected patient; returns `draft_id` |
| 2.5 | Transcript persistence | On Done → PATCH draft with `original_transcript`, status → `DRAFT` |
| 2.6 | Text-entry fallback | Shown automatically if mic permission denied or WebSocket fails |

**Exit criteria:** Record 30 s of caregiver speech → transcript appears live → Done → draft stored in DB.

---

## Stage 3 — Extraction: Transcript → Structured Draft

**Goal:** Raw transcript is parsed into measurements and observations the system can work with.

| # | What | Detail |
|---|------|--------|
| 3.1 | Extraction service | Server-side module: regex + rule-based NLP over transcript; no LLM needed for MVP |
| 3.2 | Measurement parsing | Blood pressure, glucose, temperature, heart rate, SpO₂ — value, unit, confidence |
| 3.3 | Observation parsing | Symptoms, pain, food, mood, sleep, free-text fallback |
| 3.4 | Time parsing | "this morning", "around noon", "yesterday" → `observation_time` + `precision` |
| 3.5 | Issue detection | Missing unit, ambiguous value, no time → populate `unresolved_issues` |
| 3.6 | Draft PATCH | `status → NEEDS_CLARIFICATION` (issues exist) or `REVIEWABLE` (clean) |
| 3.7 | Draft review screen | Show extracted measurements + observations as editable cards; read-only before clarification |

**Exit criteria:** Speak "her blood pressure was 130 over 80 this morning" → see structured card on review screen.

---

## Stage 4 — Stage 2 Voice: Clarification Agent

**Goal:** The voice agent asks only what blocks saving — one question at a time.

| # | What | Detail |
|---|------|--------|
| 4.1 | `GET /api/agent-token?draft_id=...` | Mints a single-use Voice Agent API token and returns server-built session config; browser sends prompt/context in the initial `session.update` |
| 4.2 | Clarification agent prompt | Built server-side from `unresolved_issues`; asks one question and submits the caregiver's answer through a tool call |
| 4.3 | Voice agent screen | Animated listening UI; agent speaks question, caregiver responds, repeat |
| 4.4 | `POST /api/drafts/:id/clarify` | Receives agent answer event; re-runs extraction on amended draft; updates `clarification_log` |
| 4.5 | Turn loop | After each answer: re-evaluate issues → next question or → `REVIEWABLE` |
| 4.6 | Skip/manual override | "Finish and review" leaves unanswered issues unresolved and flagged; caregiver can return to clarification later |

**Exit criteria:** Say "glucose was 130" without units → agent asks "mg/dL or mmol/L?" → caregiver clarifies the unit → issue resolved. Blood pressure values use mmHg and should not trigger a glucose-unit question.

---

## Stage 5 — Review, Correction & Confirmation

**Goal:** Caregiver sees and corrects the draft before any report is created.

| # | What | Detail |
|---|------|--------|
| 5.1 | Review screen (full) | Structured cards per measurement + observation, editable inline; unresolved issues flagged |
| 5.2 | Visual correction | Edit card value/unit/time inline → `PATCH /api/drafts/:id` → new revision logged |
| 5.3 | Confirm button | Explicit button tap → `POST /api/drafts/:id/confirm` → `confirmation_method: button` |
| 5.4 | Voice confirmation | Agent says summary, caregiver says "yes" → `confirmation_method: voice` |
| 5.5 | Confirmation guard | No report created without `confirmed_at` on current revision |

**Exit criteria:** Edit a value, tap Confirm — draft shows `CONFIRMED` status.

---

## Stage 6 — Save, History & Exports

**Goal:** Confirmed draft becomes an immutable report; caregiver can view history and export.

| # | What | Detail |
|---|------|--------|
| 6.1 | `POST /api/reports` | Batched transaction: insert report + set `current_report_id` on draft; idempotent via key + content hash |
| 6.2 | History screen | Chronological list of saved reports per patient; tap to open |
| 6.3 | Report detail | Full view: measurements, observations, time, transcript |
| 6.4 | Doctor export | Structured text: date/time, vitals table, symptom summary |
| 6.5 | Family export | Plain-language paragraph; no medical jargon |
| 6.6 | JSON/CSV download | Deterministic serialisation of `measurements` + `observations` JSONB |
| 6.7 | Print view | Clean `@media print` layout; no navigation chrome |

**Exit criteria:** Confirm a report → Save → appears in history → all three exports produce non-empty output.

---

## Stage 7 — Personal Expressions Memory

**Goal:** The system learns the caregiver's language, with explicit permission.

| # | What | Detail |
|---|------|--------|
| 7.1 | Detection | After clarification, if phrase is unambiguous and reusable, surface "Remember this?" prompt |
| 7.2 | Permission UX | Card: "Remember that 'pulsera' means heart rate for María?" — Yes / Not now |
| 7.3 | `POST /api/expressions` | Stores phrase + `normalized_meaning` + patient scope; requires explicit `confirmed_at` |
| 7.4 | Lookup at extraction | Stage 3 checks `personal_expressions` table before falling back to generic parser |
| 7.5 | Expression management | Settings panel: list remembered phrases, delete any |

**Exit criteria:** Say an expression, confirm it, start a new session — same phrase resolves without a question.

---

## Stage 8 — Polish, Error States & Demo Hardening

**Goal:** The app is robust enough to demo live to a judge who may try to break it.

| # | What | Detail |
|---|------|--------|
| 8.1 | Error boundaries | Friendly fallback UI for every async failure path |
| 8.2 | Loading states | Skeleton screens; no layout shift |
| 8.3 | Offline / STT failure | Auto-switch to text fallback; clear user messaging |
| 8.4 | Session expiry UI | "Your demo expired" screen with one-tap restart |
| 8.5 | Accessibility | Keyboard nav, ARIA labels on all interactive elements |
| 8.6 | Mobile layout | The recording flow must work on a phone held portrait |
| 8.7 | Demo walkthrough | In-app guided tooltip sequence for first-time judges |

**Exit criteria:** A non-technical judge completes the full flow on mobile without assistance.

---

## Stage order rationale

Stages 1–3 + 5–6 form the complete happy path with unambiguous input. Stage 4 (clarification agent) slots in between 3 and 5 once the backbone is solid. Stage 7 builds on top of the clarification audit log. Stage 8 is the final hardening pass.

```
1 (Shell) → 2 (Record) → 3 (Extract) → 5 (Review/Confirm) → 6 (Save/Export)
                                      ↘ 4 (Clarify) ↗
                                                         ↘ 7 (Memory) → 8 (Polish)
```
