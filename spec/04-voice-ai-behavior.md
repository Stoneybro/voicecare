# Segment 4: Voice and AI Behavior

## Responsibilities

AssemblyAI provides live transcription, conversational turns, spoken responses, and tool calls. VoiceCare owns the structured draft, validation rules, confirmation state, persistent vocabulary, and final save decision.

The model may propose an interpretation. The backend determines whether that interpretation is complete and eligible for confirmation.

## Agent behavior

The voice agent shall:

- Use short, plain sentences.
- Refer to the selected patient by the configured display name.
- Extract only information supported by the caregiver's current speech, established patient settings, or explicitly retrieved personal expressions.
- Ask about uncertainty that changes the stored clinical meaning.
- Avoid diagnosis, prognosis, treatment instructions, and invented context.
- State what remains unresolved.
- Read values with their units during review.
- Ask for confirmation only after the backend reports that the draft is ready.

## Structured extraction contract

The agent submits proposed draft updates through a tool call. A draft update contains:

```json
{
  "patient_id": "patient_123",
  "observation_time": "2026-09-19T08:00:00+01:00",
  "observation_time_status": "explicit",
  "measurements": [
    {
      "type": "blood_pressure",
      "systolic": 138,
      "diastolic": 88,
      "unit": "mmHg",
      "source_text": "pressure was one thirty-eight over eighty-eight"
    }
  ],
  "observations": [
    {
      "category": "pain",
      "text": "Left knee pain",
      "body_location": "left knee",
      "negated": false,
      "source_text": "her left knee was hurting"
    }
  ]
}
```

The backend validates tool arguments and returns either the updated draft or a list of issues requiring clarification.

## Material ambiguity rules

Clarification is required when any of the following changes the meaning of a stored field:

- The patient is not established.
- A numeric value cannot be reliably associated with a measurement type.
- A unit is missing and no confirmed device or patient setting supplies it.
- Blood-pressure values or their order are unclear.
- A correction contains competing values.
- The observation time could refer to materially different periods.
- Negation, subject, symptom location, or whether an event actually occurred is unclear.
- A remembered expression conflicts with the current sentence.

Clarification is not required for cosmetic punctuation or wording that does not change stored meaning.

## Unit policy

- Units may come from explicit speech or a confirmed patient/device setting.
- Units shall never be selected only because a numeric value appears plausible.
- Inferred configured units shall be spoken during readback.
- A caregiver can override a configured unit for the current measurement.
- Values are stored in the reported unit; normalized values may be derived separately and labeled as such.

## Time policy

- “This morning,” “yesterday,” and similar phrases are resolved using the caregiver's timezone and session date.
- If a phrase maps to a period rather than an exact time, the original phrase and reduced precision are preserved.
- The system shall not substitute entry time for observation time without labeling it as assumed.

## Personal-expression policy

Remembered expressions are retrieved by caregiver and compatible patient context. They serve as interpretation context, not unconditional replacements.

For example, remembering “heart” as heart rate does not allow “her heart hurts” to become a numeric measurement. Sentence context, field shape, and readback still apply.

## Confirmation state machine

```text
CAPTURING → DRAFT → NEEDS_CLARIFICATION → REVIEWABLE → CONFIRMED → SAVED
                 ↘                     ↗
                   CORRECTING ─────────
```

Any draft-changing event after `REVIEWABLE` or `CONFIRMED` creates a new revision and returns the report to `DRAFT` or `NEEDS_CLARIFICATION`. Only the backend can transition a confirmed revision to `SAVED`.

## Suggested voice wording

- Clarification: “You said the sugar was 6.2. Does the meter use mmol/L or mg/dL?”
- Correction check: “I changed the temperature to 37.2 degrees Celsius.”
- Review: “I have blood pressure 138 over 88, glucose 6.2 millimoles per litre, temperature 37.2 degrees Celsius, and pain in the left knee. Is that correct?”
- Unresolved state: “I still need the glucose unit before this report can be saved.”

