# VoiceCare Product Specification

- Status: Draft 2
- Target: AssemblyAI Voice Agent Hackathon prototype
- Primary platform: Mobile-friendly web application
- Initial language: English

VoiceCare helps a non-professional caregiver record a patient's measurements and day-to-day observations by speaking naturally. The system extracts a structured draft, asks about important ambiguities, reads the result back, and saves it only after explicit confirmation.

The hosted hackathon build is an unattended demo that judges can open and test without setup. It uses fictional information and
an anonymous, browser-scoped demo session instead of registration or login. This is a prototype architecture, not a production
healthcare deployment.

This specification is divided into independently reviewable segments:

1. [Product scope](01-product-scope.md)
2. [Users and experience flows](02-users-and-flows.md)
3. [Functional requirements](03-functional-requirements.md)
4. [Voice and AI behavior](04-voice-ai-behavior.md)
5. [Data and technical architecture](05-data-and-architecture.md)
6. [Safety, privacy, and reliability](06-safety-privacy-reliability.md)
7. [Testing and delivery](07-testing-and-delivery.md)

## Product principles

- Voice is the primary interface.
- The caregiver remains in control of what is saved.
- Uncertainty is made visible and resolved before confirmation.
- Original wording is preserved alongside structured data.
- The product records observations; it does not diagnose or prescribe.
- The hackathon version demonstrates a reliable narrow workflow rather than broad clinical coverage.
- A judge can start the demo without creating an account.
- Each browser's demo data is isolated from other judges.

## Key terms

- **Care report:** One caregiver submission describing measurements or observations for one patient and observation period.
- **Draft:** Extracted information that has not yet been confirmed.
- **Confirmed report:** A draft explicitly approved by the caregiver.
- **Personal expression:** A caregiver-specific phrase whose meaning has been explicitly confirmed for future use.
- **Observation time:** When the measurement or event occurred.
- **Entry time:** When the caregiver submitted the report.
- **Demo session:** A temporary, server-issued browser session that isolates one judge's fictional caregiver, patient, and records.
