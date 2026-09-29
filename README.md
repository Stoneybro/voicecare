# VoiceCare

**A voice-first way to capture everyday care updates.** Speak naturally, review what was heard, clarify anything uncertain, and save a clear update for the right person.

VoiceCare is a hackathon demo built around fictional patients. It helps caregivers record observations; it does not diagnose or give medical advice.

## How we use AssemblyAI

VoiceCare uses two AssemblyAI products for two different parts of the experience:

1. **Streaming Speech-to-Text** powers the recording screen. Audio streams from the browser as the person speaks, and the live transcript appears beside the recording controls. The connection uses Streaming v3 with `universal-streaming-english` and the `medical-v1` domain.
2. **Voice Agent API** powers spoken clarification. When the draft has a blocking detail to resolve, the agent asks a focused question, listens to the answer, and sends it to VoiceCare through a structured tool call. VoiceCare updates the draft and returns the person to review when the blocking details are clear.

Both browser experiences use short-lived tokens minted by the server. The AssemblyAI API key stays server-side.

**AssemblyAI handles the speech experience; VoiceCare handles the care workflow.** The transcript is organized into measurements and observations by VoiceCare’s extraction step. An optional Gemini key enables natural-language extraction; without it, the built-in parser is used. The person can review and correct the result before saving it.

Learn more: [Streaming Speech-to-Text](https://www.assemblyai.com/docs/streaming), [Medical Mode](https://www.assemblyai.com/docs/streaming/medical-mode), [Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api), and [browser token setup](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration).

## Try the demo

1. Choose Rosa or John on the home screen and start a voice update.
2. Say something like:

   > Today after breakfast, Rosa's blood pressure was 120 over 80. Her blood sugar was 110. Her left knee hurts when she walks.

3. Stop recording and review the transcript and captured details. If VoiceCare asks about the blood sugar unit, check the meter display; for this sample, answer **“milligrams per deciliter.”** The Voice Agent will resolve the detail and return you to review.
4. Save the update, open it from Saved Reports, and preview the doctor summary, family summary, JSON, CSV, or print layout.

Use **Reset demo** on the home screen to clear the demo workspace before another run. Please use fictional demo information, not real patient data.

## Run locally

You need Node.js 24 or later, pnpm through Corepack, an AssemblyAI API key, and a Neon Postgres database.

```bash
corepack pnpm install
cp apps/web/.env.example apps/web/.env.local
```

Add your credentials to `apps/web/.env.local`:

- `ASSEMBLYAI_API_KEY` — required for live transcription and Voice Agent clarification.
- `DATABASE_URL` — required for the app to connect to Neon.
- `DATABASE_URL_UNPOOLED` — recommended for applying the database schema.
- `GEMINI_API_KEY` — optional; enables natural-language extraction instead of the built-in parser.

Apply the schema and start the app:

```bash
corepack pnpm --filter @voicecare/web db:apply
corepack pnpm dev
```

Open the local URL printed by Next.js. Microphone access requires a secure browser context; localhost works for local development.

## Where to look in the code

- [Live recording and Streaming v3 connection](apps/web/src/components/recording-screen.tsx)
- [Server-minted Streaming token](apps/web/src/app/api/stt-token/route.ts)
- [Voice Agent WebSocket, audio, and tool handling](apps/web/src/components/clarification-screen.tsx)
- [Server-minted Voice Agent token and session instructions](apps/web/src/app/api/agent-token/route.ts)
- [Clarification answer updates the draft](<apps/web/src/app/api/drafts/[id]/clarify/route.ts>)

## Checks

```bash
corepack pnpm typecheck
corepack pnpm lint
```
