# Segment 1: Product Scope

## Problem

People living with chronic conditions are cared for day-to-day by family members and other non-professional caregivers — the daughter checking blood pressure every morning, the husband monitoring blood sugar, the relative noticing appetite, pain, sleep, or mood changes. Their observations are what the doctor needs **between appointments**, but existing tools are made for medical personnel: medical terminology, forms, structured fields. That friction hits hardest for ordinary users and for caregivers who are not comfortable with technology, leaving the between-appointment record scattered, incomplete, or dependent on memory.

## Product proposition

VoiceCare lets a caregiver speak as naturally as they would in a voice note — no terminology, no forms. **Stage 1** records the note with live medical transcription and stays silent until the caregiver taps Done. **Stage 2** has the VoiceCare agent ask for whatever is missing or ambiguous, one short question at a time. The caregiver's expression is learned once a personal phrase is clarified and remembered, so the experience gets smoother over time. The confirmed record then exports in formats each reader can use, giving the doctor a clearer picture and the whole care circle continuity until the next appointment.

The core interaction is:

**Speak → Done → Clarify → Review → Confirm → Save → Export (doctor / family / files)**

## MVP goal

Demonstrate that a caregiver can create an accurate, reviewable care report through a voice-first flow with less effort than manually completing a medical-style form. Show proper avenues to export the data for doctors, family, and continuing caregivers.

## MVP success criteria

- A caregiver can start recording from the home screen with one primary action.
- A first-time judge can open the deployed application and begin without registration, login, or manual setup.
- Stage 1 records a voice note with live medical transcription (AssemblyAI Streaming STT, domain medical-v1, no turn-by-turn chat); tapping Done ends recording.
- Stage 2 clarifies missing information through a turn-based voice agent that asks only what blocks saving.
- Supported measurements and observations are extracted into a draft.
- Missing or ambiguous units, values, subjects, and times are resolved or marked unresolved.
- The caregiver hears and sees the same draft before saving.
- No report is treated as confirmed without an explicit confirmation event.
- Confirmed reports appear in chronological history.
- A caregiver-specific expression can be clarified, remembered with permission, and used in a later session.
- Confirmed reports export three ways from the same data: a structured doctor summary, a plain-language family summary, and JSON/CSV files.

## MVP scope

The prototype supports:

- One anonymous, browser-scoped demo workspace containing a fictional caregiver and patients (add new patients and switch between them from the home screen).
- One patient selected per recording session.
- English voice input and spoken responses.
- Two-stage voice: Stage 1 voice-note recording with live medical transcription; Stage 2 turn-based clarification with the Voice Agent API.
- Blood pressure, blood glucose, temperature, heart rate, and oxygen saturation.
- Symptoms, pain location, food intake, mood, sleep, and free-text observations.
- Spoken clarification, visual correction, confirmation, history, and exports.
- Persistent personal expressions scoped to the caregiver and patient where appropriate.
- Deterministic exports (no LLM generation): doctor-structured text, family plain-language text, JSON and CSV downloads, plus print.
- A text-entry fallback when microphone access or browser audio is unavailable.
- A reset action that gives the judge a clean demo workspace.

## Non-goals for the hackathon

- Diagnosis, treatment advice, medication changes, or clinical decision support.
- Automated emergency assessment or replacement for emergency services.
- Direct integration with electronic health record systems.
- Clinician accounts, clinician messaging, or automated delivery to a doctor.
- Multiple caregivers editing the same report concurrently.
- Continuous passive monitoring or wearable-device ingestion.
- Claims of clinical validation, regulatory approval, or production readiness.
- Support for every medical measurement, language, accent, or care setting.

## Assumptions

- The caregiver has permission to record information about the patient.
- Device units can be configured or confirmed when first encountered.
- The prototype uses fictional patient data during demonstrations and evaluation.
- An internet connection is available during voice sessions.
- The hosted prototype issues a secure anonymous session cookie to isolate each browser's demo records.
- A demo session and its records may expire after 72 hours.
