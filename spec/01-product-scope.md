# Segment 1: Product Scope

## Problem

Family members and other non-professional caregivers often hold useful information about a patient's condition between appointments. Existing tools commonly require typed notes, medical vocabulary, or structured form entry. This creates friction and can leave the information scattered, incomplete, or dependent on memory.

## Product proposition

VoiceCare lets a caregiver speak as naturally as they would in a voice note. It turns that speech into a structured care report, clarifies important uncertainty, reads the draft back, and saves it only after the caregiver confirms it. This structured data can then be given to a healthcare professional or used to help with proper continuity of care.

The core interaction is:

**Speak → Clarify → Review → Confirm → Save → Export**

## MVP goal

Demonstrate that a caregiver can create an accurate, reviewable care report through a voice-first flow with less effort than manually completing a medical-style form. Show a proper avenue to export the data.

## MVP success criteria

- A caregiver can start recording from the home screen with one primary action.
- A first-time judge can open the deployed application and begin without registration, login, or manual setup.
- Supported measurements and observations are extracted into a draft.
- Missing or ambiguous units, values, subjects, and times are resolved or marked unresolved.
- The caregiver hears and sees the same draft before saving.
- No report is treated as confirmed without an explicit confirmation event.
- Confirmed reports appear in chronological history.
- A caregiver-specific expression can be clarified, remembered with permission, and used in a later session.
- A printable patient summary can be generated from confirmed reports.

## MVP scope

The prototype supports:

- One anonymous, browser-scoped demo workspace containing a fictional caregiver and patient.
- One patient selected per recording session.
- English voice input and spoken responses.
- Blood pressure, blood glucose, temperature, heart rate, and oxygen saturation.
- Symptoms, pain location, food intake, mood, sleep, and free-text observations.
- Spoken clarification, visual correction, confirmation, history, and printable summary.
- Persistent personal expressions scoped to the caregiver and patient where appropriate.
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
