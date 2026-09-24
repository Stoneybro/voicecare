# VoiceCare — what it is, and why it is feasible on AssemblyAI

**VoiceCare is a platform where caregivers record observations between doctor's appointments, and those observations become structured data medical personnel can use.** It is built for the AssemblyAI Voice Agent Hackathon, so AssemblyAI tools carry the entire voice pipeline.

**The friction we remove:** most medical platforms are made for medical personnel — medical terminology, forms, structured fields. That is hard for ordinary users, let alone caregivers of chronic patients who may barely use technology. So taking an observation must feel like recording a voice note: open the app, speak freely, tap Done. No forms, no terminology test.

**How it works (two stages):**

1. **Stage 1 — Voice note.** The caregiver records freely while AssemblyAI's medical STT transcribes live (pure recording plus live transcription, no turn-by-turn chat). Tapping Done ends the note.
2. **Stage 2 — Clarification.** Our VoiceCare agent (AssemblyAI Voice Agent API, turn-based conversation) asks for whatever is missing or ambiguous, one short question at a time.
3. **Adaptive vocabulary.** The first time a personal phrase is clarified (“her heart is 70” → heart rate 70 bpm), the caregiver can let the system remember it — so it never asks again, and the experience gets smoother over time.
4. **Exports.** The confirmed record renders in different formats for different readers: a structured doctor summary, a plain-language family summary, and JSON/CSV files — so family members, the next caregiver, or the clinic can fill the gap between appointments or continue care without losing history.

I checked the event page and AssemblyAI's current documentation. This is a **documentation-based feasibility assessment**; transcription accuracy and reliability still need live testing.

**Hackathon fit**

The event runs **September 1–30, 2026**, is online, and requires participants to build on AssemblyAI. Registration remains open throughout the build window. The listed prize pool is $10,000, split between cash and AssemblyAI credits. This proposal meets the published technology requirement twice over (Streaming STT plus Voice Agent API). [Hackathon page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)

Lablab's general guidance calls for an online working prototype, a presentation video, and a pitch deck. The event page I could access does not specify a detailed judging rubric or submission cutoff time, so those still need checking in the participant instructions. [Submission guidance](https://lablab.ai/guide)

**What AssemblyAI supports**

AssemblyAI currently documents managed Streaming STT (with a medical domain) and a managed **Voice Agent API** combining speech recognition, LLM reasoning, and spoken responses. The two-stage design maps onto them directly — no separately assembled pipeline. [API overview](https://www.assemblyai.com/docs)

| Requirement | Feasibility and implementation |
| --- | --- |
| Caregiver records a voice note with live transcription, no chat | Streaming STT WebSocket with `domain medical-v1`; browser streams 16 kHz PCM, finals accumulate, `Terminate` on Done. Fallback: async transcription with the same domain. |
| Agent asks for missing information after Done | Voice Agent API: inject the Stage 1 transcript via `conversation.message` + `reply.create`, then turn-based tool calls through `update_draft` / `ask_caregiver` / `finish_draft`. |
| Extract measurements into fields | Tool calls with structured parameters; backend validates the draft and blocks saving while required fields are unresolved. |
| Remember confirmed expressions so it never asks twice | Caregiver-scoped vocabulary store, retrieved into the agent's prompt and key terms each session; separate explicit permission before storing. |
| Read back and correct the record | Review conversation tied to the current draft revision; corrections invalidate confirmation and require re-confirmation. |
| Export for doctors, family, continuing caregivers | Deterministic renderers over the same confirmed reports: doctor-structured, family plain-language, JSON/CSV files. |

The relevant integration mechanisms are documented in [streaming authentication](https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token), [medical mode for streaming](https://www.assemblyai.com/docs/streaming/medical-mode), [browser integration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration) and [agent tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview).

**The adaptive vocabulary is feasible — with one important distinction**

There are two separate problems:

* **Hearing the words correctly.** AssemblyAI offers transcription context and key terms (plus Medical Mode) to improve recognition.
* **Understanding a caregiver's personal meaning.** The application stores confirmed associations and supplies them to the agent.

AssemblyAI explicitly distinguishes transcription context from the system prompt controlling agent behavior. Adding “heart” to a vocabulary list does not, by itself, teach the system that a particular caregiver uses it to mean heart rate. [Transcription context documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/transcription-prompt)

For the prototype, each association is stored with its caregiver, patient scope, confirmed meaning, and confirmation date — only after separate permission — and can be corrected or deleted. Confirmation of one measurement never automatically establishes a permanent rule; the agent asks whether the expression should be remembered.

The “her heart is 70” example is useful, but a general LLM may already interpret it correctly. To demonstrate memory, show a genuinely personal expression being clarified, remembered across a new session, and corrected when its meaning changes.

**The main weakness to guard against is silent unit inference**

A sample recording may never say “mmol/L” or “Celsius,” but an output must not supply them unasked. That would conflict with the promise to confirm uncertain meanings. The implemented rules:

* Establish device units during setup or ask when first needed.
* Include units in the spoken readback.
* Leave unresolved units unknown; never choose them solely because a value looks plausible.
* Record observation time separately from entry time.
* Preserve the caregiver's original wording alongside the confirmed fields.

The same caution applies to vocabulary. Remembering “heart” as heart rate must not cause “her heart hurts” to become a measurement.

**Confirmation is an application rule, not a prompt wish**

1. The agent submits a **draft**.
2. The backend checks required fields and unresolved ambiguities.
3. The app displays and reads back that specific draft revision.
4. The caregiver confirms or corrects it (button; voice correction supported).
5. The backend saves the confirmed version once, idempotently.

Any correction invalidates the previous confirmation. A dropped connection or repeated tool call cannot create an unconfirmed or duplicate report.

**What is built for this hackathon**

One patient selected per session (with add/switch), English initially, and the five vitals plus six observation categories. Included:

* Speak (live medical captions) → Done → clarify → review/correct → confirm → save → export.
* Persistent adaptive vocabulary.
* Chronological history per patient.
* Three exports from the same confirmed data: doctor-structured, family plain-language, JSON/CSV files.

Clarification and readback are audible so the user is never forced to read a medical form.

AssemblyAI's voice-agent language support has separate input and output lists (18 input languages, six spoken outputs). Test the actual languages and accents served rather than treating listed support as proof. [Supported languages](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/supported-languages)

AssemblyAI's **Medical Mode is available for both pre-recorded and streaming speech-to-text**, which is exactly what Stage 1 uses. Medical Mode is not documented inside the managed Voice Agent API, which is why Stage 2 uses transcription prompts and key terms instead. [Pre-recorded Medical Mode](https://www.assemblyai.com/docs/pre-recorded-audio/medical-mode) and [streaming Medical Mode](https://www.assemblyai.com/docs/streaming/medical-mode)

**Feasibility tests to run first**

Use about 40–60 fictional care reports spoken by several people, including likely users' accents and ordinary background noise.

| Test | Expected behavior |
| --- | --- |
| “Pressure is one thirty-eight over eighty-eight” | Preserve both numbers and their order. |
| “Sugar is six point two” with no established unit | Ask about units. |
| “Seventy—sorry, seventy-two” | Use the correction. |
| “She had pain yesterday, but none today” | Preserve timing and negation. |
| Streaming blocked mid-note | Fall back to the backup recording without losing the note. |
| Newly confirmed personal expression, then a fresh session | Retrieve the association and still read back the record. |
| “Her heart hurts” after learning “heart” means pulse | Preserve the symptom; avoid applying the measurement shortcut. |
| Caregiver corrects the readback | Update the draft and request confirmation again. |
| Connection drops before confirmation | Leave the record unconfirmed. |
| Export the same reports three ways | Doctor, family, and file outputs agree with the confirmed data. |

Measure **exact field accuracy**, including value, unit, patient, and time — not just readable transcripts. Also measure unnecessary questions, task completion time, and duplicate or unconfirmed saves.

The prototype gate: **zero silent unit assignments and zero unconfirmed saves in the test set**, with every confirmed numeric field matching the intended record. Passing a small test set supports a demo, not clinical reliability.

Use fictional patient information throughout. Voice Agent and streaming sessions can retain recordings and transcripts, so retention needs explicit review before using real care data. [Session history documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-history)

**Proceed with the idea.** Build and test the record-then-clarify loop first. Its reliability — and whether caregivers find speaking plus answering easier than a form — determines whether the product delivers on the pitch: continuity between appointments for chronic care.
