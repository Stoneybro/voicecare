# Segment 3: Functional Requirements

## Home and patient context

- **FR-000:** A first-time visitor shall receive an anonymous, browser-scoped demo session without registration or login.
- **FR-001:** The home screen shall show the active patient and one prominent action to begin speaking.
- **FR-002:** The user shall select or confirm the patient before audio is accepted for a new report.
- **FR-003:** The home screen shall provide access to confirmed history.
- **FR-004:** The interface shall expose session state through text and an accessible visual indicator.
- **FR-005:** Every patient, draft, report, summary, and personal-expression operation shall be scoped to the server-resolved demo session.
- **FR-006:** The user shall be able to reset the demo and receive a clean fictional workspace.

## Capture and transcription

- **FR-010:** The application shall request microphone permission only when needed and explain why it is required.
- **FR-011:** The browser shall obtain a short-lived Voice Agent token from the backend; the AssemblyAI API key shall not be exposed to the client.
- **FR-012:** The application shall preserve the final caregiver transcript associated with the report draft.
- **FR-013:** The application shall keep observation time separate from entry time.
- **FR-014:** The user shall be able to stop or cancel a recording session.
- **FR-015:** If microphone capture is unavailable, the user shall be able to submit a typed observation and continue through the same draft and confirmation flow.

## Structured draft

- **FR-020:** The system shall support the measurement types listed in the MVP scope.
- **FR-021:** Each numeric measurement shall contain a value, unit, its own observation time or time status, source wording, and resolution status.
- **FR-022:** Blood pressure shall preserve systolic and diastolic values in their spoken order.
- **FR-023:** The draft shall support symptoms and observations without forcing them into numeric fields.
- **FR-024:** The draft shall represent negation and timing, including statements such as “pain yesterday, but none today.”
- **FR-025:** Unknown information shall remain unknown rather than being silently filled with a default.
- **FR-026:** Measurements and observations shall be validated against one shared schema used by the agent tools, backend, frontend, and tests.
- **FR-027:** A report-level observation time may be used as a default, but an individual measurement or observation may override it.

## Clarification and correction

- **FR-030:** The system shall ask a clarification question when a material field has more than one reasonable interpretation.
- **FR-031:** Questions shall address one compact ambiguity at a time unless related fields can be safely resolved together.
- **FR-032:** The caregiver shall be able to answer clarification questions by voice or touch.
- **FR-033:** The caregiver shall be able to correct any extracted field before saving.
- **FR-034:** A correction shall invalidate a previous confirmation.
- **FR-035:** The app shall visually mark unresolved items and shall not present them as confirmed values.
- **FR-036:** Every draft-changing request shall include the revision it expects to update; a stale request shall be rejected and the latest draft returned.

## Confirmation and saving

- **FR-040:** The system shall read the complete saveable draft aloud and display the same information.
- **FR-041:** Saving shall require an explicit confirmation tied to the current draft revision.
- **FR-042:** Silence, acknowledgement sounds, connection loss, or an unrelated “yes” shall not count as confirmation.
- **FR-043:** The backend shall reject attempts to save a draft with unresolved required fields.
- **FR-044:** Save operations shall use an idempotency key so retries cannot create duplicate reports.
- **FR-045:** The interface shall show a clear success or failure result after a save attempt.
- **FR-046:** Reusing an idempotency key for different save content shall be rejected.

## Personal expressions

- **FR-050:** A personal expression shall be stored only after separate, explicit permission to remember it.
- **FR-051:** A stored expression shall include its normalized meaning, scope, original phrase, and confirmation date.
- **FR-052:** The caregiver shall be able to view, correct, or delete remembered expressions.
- **FR-053:** A personal expression shall influence interpretation only when its context is compatible.
- **FR-054:** All fields produced using a remembered expression shall remain subject to normal review and confirmation.

## History and export

- **FR-060:** History shall contain confirmed reports only by default.
- **FR-061:** Each history item shall identify the patient, observation time, entry time, and reporting caregiver.
- **FR-062:** The caregiver shall be able to open a full report and see structured data plus original wording.
- **FR-063:** The app shall generate a print-friendly summary for a selected date range.
- **FR-064:** The summary shall state that it contains caregiver-reported observations and is not a clinical record or diagnosis.

## Accessibility

- **FR-070:** Primary actions shall have large touch targets and visible text labels.
- **FR-071:** Voice-only operation shall not be required for correction or confirmation.
- **FR-072:** Status and errors shall not be communicated by color alone.
- **FR-073:** The core flow shall be keyboard navigable and compatible with screen-reader labels.
