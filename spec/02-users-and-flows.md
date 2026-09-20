# Segment 2: Users and Experience Flows

## Primary user

The primary user is a family member or non-professional home caregiver who observes a patient's daily condition but may not know medical terminology or feel comfortable completing complex digital forms.

Typical needs include:

- Recording several measurements at once.
- Describing symptoms and ordinary observations in familiar language.
- Correcting speech recognition without restarting.
- Remembering what happened across multiple days.
- Presenting a concise record during an appointment.

## Secondary audience

A doctor or other healthcare professional may read a caregiver-generated summary. The MVP does not give this audience an account or imply that the information has been clinically verified.

## Primary flow: create a report

1. The caregiver opens VoiceCare.
2. The app shows the selected patient and a prominent **Speak** button.
3. The caregiver starts a session and describes the patient's measurements and observations.
4. The system builds a draft while preserving the original transcript.
5. The system asks concise questions about material ambiguities.
6. The system reads the resolved draft back and displays it as editable fields.
7. The caregiver corrects any item by voice or touch.
8. A correction invalidates any prior confirmation and triggers a new review.
9. The caregiver explicitly selects or says **Confirm and save**.
10. The backend atomically saves one confirmed report and shows it in history.

## First-use unit flow

1. The caregiver says, “Her sugar is six point two.”
2. No glucose unit has been configured for the patient.
3. The system asks whether the device uses mmol/L or mg/dL.
4. The caregiver chooses or says the unit.
5. The system uses the unit in the current draft.
6. The app separately asks whether to remember that device unit for future reports.

The numeric value must remain unresolved until the unit question is answered. A plausible range is not sufficient evidence for choosing a unit.

## Personal-expression flow

1. The caregiver says an ambiguous phrase such as, “Her engine is 74.”
2. The system asks what “engine” means in this context.
3. The caregiver identifies it as heart rate.
4. The current draft is updated.
5. The system separately asks whether the caregiver wants this expression remembered.
6. If approved, the association is stored with its scope and confirmation date.
7. In a later session, the expression can populate a heart-rate draft, but it is still included in readback.

## Correction flow

The caregiver can correct a draft by saying, for example, “The temperature was 37.2, not 37.4,” or by editing the visible value. The system must:

- Update only the referenced field when the target is clear.
- Ask which field is meant when the target is ambiguous.
- Retain a revision trail within the draft.
- Read back the changed item and any dependent interpretation.
- Require confirmation again after every correction.

## History and summary flow

The caregiver can:

- View confirmed reports in reverse chronological order.
- Open a report to see structured fields, original wording, observation time, and entry time.
- Filter the summary by date range.
- Generate a print-friendly summary showing measurements and observations chronologically.
- Clearly distinguish caregiver-reported information from clinician-authored information.

## Essential interface states

- Ready to speak.
- Listening.
- Processing.
- Clarification needed.
- Draft ready for review.
- Correcting draft.
- Saving.
- Saved.
- Connection interrupted.
- Unconfirmed draft available for recovery or discard.

