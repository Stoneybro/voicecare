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

- Zero silent unit assignments in the final test set.
- Zero unconfirmed saves.
- Zero duplicate reports from repeated save attempts.
- Every saved numeric field matches the caregiver-confirmed value and unit.
- Every post-confirmation correction requires a new confirmation.
- Every connection-loss test leaves the report unconfirmed unless saving completed beforehand.
- The complete demo flow works on the selected presentation browser.

These gates establish demo readiness only.

## Delivery segments

### Build segment A: voice capture

- Mobile-friendly home screen.
- Temporary token endpoint.
- Browser audio connection.
- Live transcript and session-state display.

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

### Build segment E: evaluation and presentation

- Fictional test dataset.
- Recorded results against release gates.
- Hosted prototype.
- Demo video and pitch deck.

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
- Authentication method for the hosted demo.
- Whether unconfirmed drafts survive browser restarts.
- Exact retention period for local drafts and confirmed reports.
- Whether spoken confirmation is enabled for the demo or the primary confirmation is a button.
- The final set of supported observation categories.

