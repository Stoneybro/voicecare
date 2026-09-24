# Segment 2: Users and Experience Flows

## Primary user

The primary user is a family member or non-professional home caregiver for someone with a chronic condition — observing daily measurements and changes but possibly unfamiliar with medical terminology and uncomfortable with complex digital forms. Taking an observation must feel like recording a voice note, not operating a medical device.

Typical needs include:

- Recording several measurements at once, with pauses to read a device.
- Describing symptoms and ordinary observations in familiar language.
- Being heard correctly without repeating or restarting.
- Correcting speech recognition without restarting.
- Remembering what happened across multiple days and patients.
- Presenting a concise record during an appointment, and handing continuity to family or the next caregiver.

## Secondary audience

Doctors, other medical personnel, family members, and continuing caregivers read what the primary user records. The MVP gives none of them an account: they receive exports (doctor-structured, family plain-language, JSON/CSV files). Every export states the information is caregiver-reported, not clinically verified.

## Primary flow: record a voice note, clarify, save, export

1. The caregiver opens VoiceCare and the app creates or restores an anonymous demo session.
2. The app checks its database connection, loads the fictional patients, and shows the selected patient plus a prominent **Speak Care Note** button.
3. **Stage 1 — Voice note.** The caregiver speaks freely in their own words, with pauses. Live medical transcription appears as captions (no agent chat, no interruptions). Tapping **Done Speaking** ends recording. If live streaming fails, the backup recording is transcribed instead — the note is never lost.
4. **Stage 2 — Clarification.** The transcript moves to the VoiceCare agent, which asks concise turn-based questions about material ambiguities only (missing units, unclear values or meanings).
5. The system builds a draft while preserving the original transcript and the caregiver's exact wording per field.
6. The system reads the resolved draft back — with units spoken aloud — and displays the same information.
7. The caregiver corrects any item by voice or touch.
8. A correction invalidates any prior confirmation and triggers a new review.
9. The caregiver explicitly selects **Confirm and save**.
10. The backend atomically saves one confirmed report and shows it in history.
11. The caregiver exports the confirmed record for whoever needs it next: doctor summary for the appointment, family summary in plain words, or JSON/CSV files for continuing care.

No registration or login is required. The server-issued demo session determines which caregiver, patient, drafts, reports, and
personal expressions the browser may access.

## Remote-judge startup and reset flow

1. A judge opens the deployed HTTPS URL in a supported browser.
2. The app calls `GET /api/bootstrap` to create or restore the browser's demo session.
3. The app shows **Ready to speak** only after the session, fictional patient, and database are ready.
4. The page provides an example sentence and explains microphone access before requesting it.
5. If microphone access is unavailable, the judge can enter the same observation as text and continue through clarification,
   correction, confirmation, history, and export.
6. **Reset demo** calls `POST /api/reset`, abandons the current session, and creates a clean workspace that cannot access the
   earlier session's data.

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
- Require confirmation again after every correction, including after the report was saved.
- Never edit or remove a saved report. Confirming the corrected revision saves a new report that becomes the draft's current
  report, and the earlier report remains as the superseded record.

## Patient switcher flow

The caregiver can care for more than one person. Pill tabs list each patient plus **Add patient**. Switching loads that patient's own current draft, history, and remembered expressions; voice sessions re-mint with the selected patient's name, units, and vocabulary. Adding a patient takes only a name — no demographics the demo does not need.

## History and export flow

The caregiver can:

- View current confirmed reports in reverse chronological order, with superseded revisions excluded by default.
- See when a report was updated and open its earlier revisions when the audit trail is needed.
- Open a report to see structured fields, original wording, observation time, and entry time.
- Filter exports by date range.
- Export the same confirmed reports three ways: a structured **doctor** summary to bring to the appointment, a plain-language **family** summary anyone can read, and **JSON/CSV files** so another caregiver or a clinic system can carry the data forward.
- Print any text summary; download the files.
- Clearly distinguish caregiver-reported information from clinician-authored information — every export carries the disclaimer.

## Essential interface states

- Ready to speak.
- Recording with live transcription.
- Checking the recording.
- Clarification needed.
- Draft ready for review.
- Correcting draft.
- Saving.
- Saved.
- Connection interrupted.
- Unconfirmed draft available for recovery or discard.
- Preparing demo session.
- Microphone unavailable with text fallback.
- Demo reset complete.
