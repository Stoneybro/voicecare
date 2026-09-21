# Segment 7: Testing and Delivery

## Evaluation dataset

Create 40–60 fictional care reports spoken by several participants. Include intended accents, ordinary room noise, self-corrections, pauses, negation, relative dates, and personalized expressions.

Each test case shall have a reference record containing:

- Expected patient.
- Expected values and units.
- Expected observation times or precision.
- Expected symptoms and negation.
- Ambiguities that must trigger questions.
- Whether a report should be eligible for confirmation.

## Core test scenarios

| Scenario | Expected result |
| --- | --- |
| “Pressure is one thirty-eight over eighty-eight” | Preserve both values and order. |
| “Sugar is six point two” without a configured unit | Ask for the unit. |
| “Seventy—sorry, seventy-two” | Use 72 and preserve the correction context. |
| “She had pain yesterday, but none today” | Preserve time and negation. |
| Personal expression used in a later session | Retrieve its meaning and include it in readback. |
| “Her heart hurts” after learning “heart” as pulse | Record a symptom; do not create a heart-rate value. |
| Correction after review | Create a new revision and require confirmation again. |
| Connection loss before confirmation | Save no confirmed report. |
| Repeated save request | Create one confirmed report. |
| Unsupported observation | Preserve it as free text without inventing a category. |

## Measures

- Exact field accuracy: patient, type, value, unit, time, negation, and body location.
- Clarification recall: proportion of required ambiguities that trigger a question.
- Unnecessary-question rate.
- Confirmed-report integrity: saved reports that exactly match the confirmed revision.
- Duplicate-save rate.
- Task completion time.
- Caregiver correction rate.
- User-rated ease compared with a simple form baseline.

## Prototype release gates

- A first-time visitor can open the deployed HTTPS URL and begin without registration, login, or manual setup.
- Two browsers receive separate demo sessions and cannot read or change each other's records.
- Zero silent unit assignments in the final test set.
- Zero unconfirmed saves.
- Zero duplicate reports from repeated save attempts.
- Every saved numeric field matches the caregiver-confirmed value and unit.
- Every post-confirmation correction requires a new confirmation.
- Every connection-loss test leaves the report unconfirmed unless saving completed beforehand.
- The complete demo flow works on the selected presentation browser.
- Refreshing the page restores the current browser's session and history.
- Denied microphone permission offers a retry and a working typed-observation fallback.
- Database or voice-service startup delay shows a clear loading state rather than a broken interface.
- **Reset demo** produces a clean fictional workspace.
- The print-friendly summary works from the deployed URL.

These gates establish demo readiness only.

## Delivery segments

### Build segment A: voice capture

- Mobile-friendly home screen.
- Anonymous-session bootstrap and fictional patient creation.
- Temporary token endpoint.
- Browser audio connection.
- Live transcript and session-state display.
- Typed-observation fallback.

### Build segment B: structured draft

- Draft tool schema.
- Backend validation.
- Supported measurements and observations.
- Visible draft editing.

### Build segment C: clarification and confirmation

- Ambiguity rules.
- Spoken questions and readback.
- Draft revision state machine.
- Explicit, idempotent save.

### Build segment D: memory and history

- Personal-expression consent and retrieval.
- Confirmed-report history.
- Date-range summary and print view.
- Session-scoped history and **Reset demo**.

### Build segment E: evaluation and presentation

- Fictional test dataset.
- Recorded results against release gates.
- Hosted prototype.
- Health endpoint and deployed smoke tests.
- Demo video and pitch deck.

## Unattended deployment checks

Before submission, test the production URL in a private window and on at least one mobile and one desktop browser. Verify that:

- `GET /api/bootstrap` creates a session and loads the fictional patient.
- `GET /api/health` confirms application and database readiness without exposing secrets.
- Microphone permission is requested only after an explanation and user action.
- Voice-token creation, connection, and safe retry work against the deployed environment.
- Two different browsers cannot see or modify each other's data.
- A database cold start resolves to **Ready to speak** within the allowed timeout.
- Raw provider, database, and stack-trace errors are replaced by friendly retry messages.
- Refresh, repeated save, history, reset, and printing all work after deployment restart.
- Environment variables and provider quotas are checked before the judging window.

## Hackathon scope classification

### Required

- Anonymous browser-scoped demo session and one fictional patient.
- Voice capture, typed fallback, structured draft, clarification, and visual correction.
- Spoken and visible review, explicit confirmation, idempotent save, and session-scoped history.
- Remembered expressions, printable summary, reset, and friendly loading, error, and retry states.

### Optional if time permits

- Spoken confirmation; the visible confirmation button remains the reliable default.
- Multiple fictional patients.
- Downloaded PDF export in addition to the browser print view.
- A detailed interface for browsing superseded revisions.

### Explicitly deferred

- Registered user accounts, passwords, and account recovery.
- Real patient data, production healthcare compliance, and enterprise security operations.
- Clinician accounts, EHR integration, advanced roles, and multi-caregiver collaboration.

## Demo script

The presentation should demonstrate one continuous story:

1. A caregiver gives several measurements and an observation naturally.
2. The system asks about a missing unit.
3. The caregiver corrects one value.
4. The agent reads the revised draft back.
5. The caregiver confirms and the report appears once in history.
6. A personal expression is clarified and remembered with permission.
7. A new session shows that memory working without bypassing review.
8. The caregiver opens a print-friendly appointment summary.

## Open decisions

- Final product name and visual identity.
- Whether spoken confirmation is enabled for the demo or the primary confirmation is a button.
- The final set of supported observation categories.

The hosted demo uses anonymous secure sessions, retains them for up to 72 hours, and restores unconfirmed drafts while the session
remains valid. These are settled prototype decisions rather than open production commitments.
