# Product Description
We are building this product for the **AssemblyAI Voice Agent Hackathon** around a simple problem: **many people living with chronic conditions are cared for day-to-day by family members and other non-professional caregivers.**

A daughter may be the person checking her mother's blood pressure every morning. A husband may be monitoring his wife's blood sugar. A relative or home caregiver may be the person noticing changes in appetite, pain, sleep, mood, or general condition.

These caregivers hold the information a doctor needs **between appointments**, but they are not healthcare professionals, and a portion of them are not comfortable with technology. Most medical platforms are made for medical personnel: they expect users to understand medical terminology, navigate forms, and enter information into structured fields. That friction leaves the between-appointment record scattered, incomplete, or dependent on memory.

We want to strip out that friction entirely.

### The Idea: a voice note first, an agent second

Instead of asking caregivers to fill out a medical form, we let them **simply talk** — taking an observation feels like recording a voice note.

The caregiver opens the app, taps **Speak Care Note**, and describes what happened in their own words, pauses and all:

> “I checked Mama this morning. Her pressure was one thirty-eight over eighty-eight, her sugar was six point two, temperature was thirty-seven point four, and her heart was beating at seventy-two. She ate about half her breakfast and said her left knee was hurting.”

**Stage 1 — Voice-note recording.** While they speak, AssemblyAI's medical speech-to-text transcribes live (pure recording plus live transcription, no back-and-forth chat). The caregiver takes as long as they need, then taps **Done**. That tap ends recording — nothing answers mid-note.

**Stage 2 — Clarification.** The transcript moves to our VoiceCare agent, built on AssemblyAI's Voice Agent API (turn-based conversation). If anything needed is missing or ambiguous — a unit, a value, a meaning — the agent asks for it, one short question at a time.

The result is turned into data structures medical personnel can actually use:

- Blood pressure — 138/88 mmHg
- Blood glucose — 6.2 mmol/L
- Temperature — 37.4°C
- Heart rate — 72 bpm
- Food intake — approximately half of breakfast
- Pain — left knee

The caregiver reviews what was understood and confirms it before anything is saved.

### Our Voice Innovation: Adaptive Health Vocabulary

The interesting part is not simply converting speech to text.

Caregivers do not speak in standardized medical terminology. They develop their own ways of describing measurements and conditions. One caregiver says “her pressure is 138 over 88,” another says “her heart is 70,” another says “her oxygen is 96.”

The system learns these expressions **from the caregiver through confirmation — once.**

If “her heart is 70” is ambiguous the first time, the voice agent asks:

> “Do you mean her heart rate is 70 beats per minute?”

The caregiver confirms, and — only with separate, explicit permission to remember it — that association becomes part of their personal vocabulary. The next time that caregiver says “her heart is 74 today,” the system understands it as heart rate without asking again. The experience gets smoother over time, while every reading is still read back before saving.

The system never silently guesses an uncertain medical meaning. Important ambiguities are confirmed with the caregiver before being stored, and a remembered phrase never overrides a genuinely different sentence (“her heart hurts” stays a symptom, never a number).

### Why Voice Matters

Voice is not a convenience feature on a conventional health form.

**Voice is the interface.**

The goal is to make the application usable by someone with little experience with technology:

**Open the app → Speak → Done → Answer → Confirm → Done.**

The caregiver doesn't need to know where a measurement belongs in a form or type long notes. They describe what they observed; the agent does the structuring.

### Connecting Caregivers With Doctors — and Everyone in Between

The purpose of the record is continuity: filling the gap between appointments, or handing over care without losing history.

The same confirmed reports export three ways from the same data:

- **Doctor** — a structured, SOAP-inspired summary (observations plus vitals) to bring to the appointment.
- **Family** — the same events in plain language anyone can read.
- **Files** — JSON and CSV downloads so another caregiver, a clinic system, or a follow-up visit can carry the data forward.

Every format carries the same disclaimer: caregiver-reported observations, to be reviewed before making medical decisions.

### Why This Fits the AssemblyAI Voice Agent Hackathon

The product uses AssemblyAI as **core infrastructure**, not as speech-to-text input:

1. **Medical STT** (Streaming STT, `medical-v1`) for the frictionless voice note with live transcription.
2. **Voice Agent API** for turn-based clarification that resolves uncertainty through tools, not guessing.
3. Transcription biasing (prompts plus key terms) and the agent's structured tool calls bridge the caregiver's natural speech and standardized health information.

The voice system has to:

1. Transcribe informal caregiver speech live, with medical terminology handled correctly.
2. Stay silent until Done — never interrupt a note to chat.
3. Extract measurements and observations from continuous speech into structured fields.
4. Handle spoken numbers accurately, including corrections.
5. Recognize context and previously confirmed caregiver vocabulary.
6. Ask for clarification when an interpretation is uncertain, then read everything back for confirmation.
7. Export the confirmed record in formats each audience can use.

The hackathon gives us an opportunity to explore what happens when **voice becomes the primary interface for a task that normally requires forms and technical knowledge** — and what continuity of care looks like when the people providing everyday care can actually record what they see.

> **Speak naturally. Let the system understand your way of speaking. Confirm what it heard. Give the doctor — and the whole care circle — a clearer picture of what happened between appointments.**
