# Product Description
We are building this product for the **AssemblyAI Voice Agent Hackathon** around a simple problem: **many people living with chronic conditions are cared for day-to-day by family members and other non-professional caregivers.**

A daughter may be the person checking her mother's blood pressure every morning. A husband may be monitoring his wife's blood sugar. A relative or home caregiver may be the person noticing changes in appetite, pain, sleep, mood, or general condition.

These caregivers have important information that a doctor needs, but they are not healthcare professionals, and they may not be comfortable using technology. Existing health applications often expect users to understand medical terminology, navigate forms, and manually enter information into structured fields.

We want to remove that barrier.

### The Idea

Instead of asking caregivers to fill out a medical form, we let them **simply talk**.

The caregiver opens the app and records what happened in their own words, just like sending a voice note.

For example:

> “I checked Mama this morning. Her pressure was one thirty-eight over eighty-eight, her sugar was six point two, temperature was thirty-seven point four, and her heart was beating at seventy-two. She ate about half her breakfast and said her left knee was hurting.”

Using **AssemblyAI's Voice Agent technology**, the application processes the caregiver's speech and identifies the relevant health information.

It can turn that recording into:

- Blood pressure — 138/88 mmHg
- Blood glucose — 6.2 mmol/L
- Temperature — 37.4°C
- Heart rate — 72 bpm
- Food intake — approximately half of breakfast
- Pain — left knee

The caregiver reviews what was understood and confirms it before the information is saved.

### Our Voice Innovation: Adaptive Health Vocabulary

The interesting part is not simply converting speech to text.

Caregivers do not necessarily speak in standardized medical terminology. They develop their own ways of describing measurements and conditions.

For example, one caregiver may say:

> “Her pressure is 138 over 88.”

Another may say:

> “Her heart is 70.”

Another may say:

> “Her oxygen is 96.”

The system can learn these expressions **from the caregiver through confirmation**.

If “her heart is 70” is ambiguous the first time, the voice agent can ask:

> “Do you mean her heart rate is 70 beats per minute?”

The caregiver confirms, and that association becomes part of their personal vocabulary.

The next time that caregiver says:

> “Her heart is 74 today.”

the system can understand it as a heart-rate measurement without requiring the caregiver to explain what they mean again.

This creates a layer between **the caregiver's natural way of speaking and standardized health information**.

The system should never silently guess an uncertain medical meaning. Important ambiguities are confirmed with the caregiver before being stored.

### Why Voice Matters

Voice is not being added as a convenience feature to a conventional health form.

**Voice is the interface.**

The goal is to make the application usable by someone who may have little experience with technology:

**Open the app → Speak → Confirm → Done.**

The home screen can therefore remain extremely simple, with a prominent **Speak** button and access to **History**.

The caregiver doesn't need to know where a particular measurement belongs in a form. They don't need to type long notes. They simply describe what they observed.

### Connecting Caregivers With Doctors

The purpose of the record is ultimately communication.

The caregiver can build a chronological record of the patient's day-to-day condition and use that information when communicating with the patient's doctor.

Instead of trying to remember several days of measurements and observations, or sending scattered unstructured messages, the caregiver can provide a clearer record containing:

- measurements
- symptoms and complaints
- changes they noticed
- food and other care observations
- dates and times of observations

This gives the doctor a better account of what happened between appointments while keeping the caregiver's interaction with the application extremely simple.

### Why This Fits the AssemblyAI Voice Agent Hackathon

The product uses the voice agent as a **core part of the application**, not merely as speech-to-text input.

The voice system has to:

1. Understand natural, sometimes informal caregiver speech.
2. Extract measurements and observations from continuous speech.
3. Handle spoken numbers accurately.
4. Recognize context and previously confirmed caregiver vocabulary.
5. Ask for clarification when an interpretation is uncertain.
6. Communicate the resulting structured information back to the caregiver for confirmation.

The hackathon gives us an opportunity to explore what happens when **voice becomes the primary interface for a task that normally requires forms and technical knowledge**.

The result is a voice-first care documentation tool that helps bridge the gap between **the people providing everyday care and the doctors responsible for that patient's medical care**.

> **Speak naturally. Let the system understand your way of speaking. Confirm what it heard. Give the doctor a clearer picture of the patient's care.**
