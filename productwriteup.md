**Yes—this is technically feasible as a hackathon prototype, and the core interaction fits the event well.** The strongest feature is the full cycle: a caregiver speaks, the agent resolves uncertainty, and the caregiver confirms an accurate record.

I checked the event page and AssemblyAI’s current documentation. This is a **documentation-based feasibility assessment**; I haven’t run audio through the API, so transcription accuracy and reliability remain to be tested.

**Hackathon fit**

The event runs **September 1–30, 2026**, is online, and requires participants to build on AssemblyAI. Registration remains open throughout the build window. The listed prize pool is $10,000, split between cash and AssemblyAI credits. Your proposed use meets the published technology requirement. [Hackathon page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)

Lablab’s general guidance calls for an online working prototype, a presentation video, and a pitch deck. The event page I could access does not specify a detailed judging rubric or submission cutoff time, so those still need checking in the participant instructions. [Submission guidance](https://lablab.ai/guide)

**What AssemblyAI can support**

AssemblyAI currently documents a managed **Voice Agent API** that combines speech recognition, LLM reasoning, and spoken responses. You can build this without separately assembling all three services. [API overview](https://www.assemblyai.com/docs)

| Your requirement                                | Feasibility and implementation                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Caregiver speaks in the browser                 | Supported through browser audio and a WebSocket connection; your backend issues temporary access tokens. |
| Agent asks clarification questions              | Supported through the conversational agent and its system prompt.                                        |
| Extract measurements into fields                | Use tool calls with structured parameters; your backend validates the resulting draft.                   |
| Remember confirmed expressions                  | Build a caregiver-specific vocabulary store and retrieve it during future sessions.                      |
| Read back and correct the record                | Implement a review conversation tied to the current draft.                                               |
| Save history and prepare a doctor-facing record | Build these in your application and database.                                                            |

The relevant integration mechanisms are documented in [browser integration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration) and [agent tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview).

**Your adaptive vocabulary is feasible—with one important distinction**

There are two separate problems:

* **Hearing the words correctly.** AssemblyAI offers transcription context and key terms to improve recognition.
* **Understanding a caregiver’s personal meaning.** Your application stores confirmed associations and supplies them to the agent.

AssemblyAI explicitly distinguishes transcription context from the system prompt controlling agent behavior. Adding “heart” to a vocabulary list does not, by itself, teach the system that a particular caregiver uses it to mean heart rate. [Transcription context documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/transcription-prompt)

For the prototype, store each association with its caregiver, relevant patient context, confirmed meaning, and confirmation date. Allow correction or deletion.

Also, **confirmation of one measurement should not automatically establish a permanent language rule**. The agent can separately ask whether the caregiver wants that expression remembered.

Your “her heart is 70” example is useful, but a general LLM may already interpret it correctly. To demonstrate the value of memory, show a genuinely personal expression being clarified, remembered across a new session, and corrected when its meaning changes.

**The main weakness in the current description is silent unit inference**

Your sample recording never says “mmol/L” or “Celsius,” but the output supplies both.

That conflicts with your promise to confirm uncertain meanings. I would implement these rules:

* Establish device units during setup or ask when first needed.
* Include units in the spoken readback.
* Leave unresolved units unknown; never choose them solely because a value looks plausible.
* Record observation time separately from entry time.
* Preserve the caregiver’s original wording alongside the confirmed fields.

The same caution applies to vocabulary. Remembering “heart” as heart rate must not cause “her heart hurts” to become a measurement.

**Make confirmation an application rule**

A prompt saying “never save without confirmation” is insufficient on its own. I recommend this implementation:

1. The agent submits a **draft**.
2. Your backend checks required fields and unresolved ambiguities.
3. The app displays and reads back that specific draft.
4. The caregiver confirms or corrects it.
5. Your backend saves the confirmed version once.

Any correction should invalidate the previous confirmation. A dropped connection or repeated tool call should not create an unconfirmed or duplicate record.

For a first version, a large **Confirm and save** button gives you a clear confirmation event; spoken confirmation can be added and tested against interruptions and ambiguous replies.

**What I would build for this hackathon**

Keep the scope to one patient per session, English initially, and the measurements and observations already in your example. Include:

* Speak, review/correct, and save.
* Persistent vocabulary memory.
* Chronological history.
* A simple printable summary for appointments.

Make clarification and readback audible so the user is not forced to read a medical form.

AssemblyAI’s voice-agent language support has separate input and output lists. The current API supports 18 input languages with native code-switching, while officially supported spoken output is limited to six languages. Test the actual languages, language combinations, and accents you intend to serve rather than treating listed support as proof of accuracy for your users. [Supported languages](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/supported-languages)

AssemblyAI’s **Medical Mode is available for both pre-recorded and streaming speech-to-text**, but the documentation does not establish that it can be enabled inside the managed Voice Agent API. For the prototype, use the Voice Agent API’s transcription prompt and key terms, or test a custom streaming pipeline if Medical Mode is essential. [Pre-recorded Medical Mode](https://www.assemblyai.com/docs/pre-recorded-audio/medical-mode) and [streaming Medical Mode](https://www.assemblyai.com/docs/streaming/medical-mode)

**The feasibility tests I would run first**

Use about 40–60 fictional care reports spoken by several people, including likely users’ accents and ordinary background noise.

| Test                                                      | Expected behavior                                              |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| “Pressure is one thirty-eight over eighty-eight”          | Preserve both numbers and their order.                         |
| “Sugar is six point two” with no established unit         | Ask about units.                                               |
| “Seventy—sorry, seventy-two”                              | Use the correction.                                            |
| “She had pain yesterday, but none today”                  | Preserve timing and negation.                                  |
| Newly confirmed personal expression, then a fresh session | Retrieve the association and still read back the record.       |
| “Her heart hurts” after learning “heart” means pulse      | Preserve the symptom; avoid applying the measurement shortcut. |
| Caregiver corrects the readback                           | Update the draft and request confirmation again.               |
| Connection drops before confirmation                      | Leave the record unconfirmed.                                  |

Measure **exact field accuracy**, including value, unit, patient, and time—not just whether the transcript looks readable. Also measure unnecessary questions, task completion time, and duplicate or unconfirmed saves.

My proposed prototype gate would be **zero silent unit assignments and zero unconfirmed saves in the test set**, with every confirmed numeric field matching the intended record. Passing a small test set would support a demo, not establish clinical reliability.

Use fictional patient information for that demo. Voice Agent sessions can retain recordings and transcripts, so retention needs explicit review before using real care data. [Session history documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-history)

**I would proceed with the idea.** Build and test the clarification-and-confirmation loop first. Its reliability—and whether caregivers find it easier than entering a form—will determine whether the product delivers on the pitch.

