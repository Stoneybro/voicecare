# VoiceCare — Stage 2 Implementation Report

**Stage:** Stage 1 Voice — Recording + Live Transcription (spec/02, Stage 2)  
**Date:** 2026-09-26  
**Status:** Implemented; typecheck, lint, and diff checks pass. Live recording and transcript save were confirmed in the browser.

---

## 1. Scope delivered

| # | What | Status | Where |
|---|---|---|---|
| 2.1 | `GET /api/stt-token` | Complete | `src/app/api/stt-token/route.ts` |
| 2.2 | Full-screen recording screen | Complete | `src/components/recording-screen.tsx` |
| 2.3 | AssemblyAI live transcription | Implemented | Browser WebSocket connection to Streaming STT v3 |
| 2.4 | `POST /api/drafts` | Complete | `src/app/api/drafts/route.ts` |
| 2.5 | Save transcript on Done | Complete | `PATCH /api/drafts/:id` in `src/app/api/drafts/[id]/route.ts` |
| 2.6 | Text-entry fallback | Complete | Available directly, and after microphone or streaming failure |

## 2. User flow

- The home screen’s Speak button opens a recording screen for the selected patient.
- The caregiver can start microphone capture or choose text entry immediately.
- Live audio is resampled to mono 16 kHz PCM16 and streamed to AssemblyAI. Partial and finalized turns are stitched into the transcript panel.
- The screen includes a listening orb, animated waveform, elapsed time, cancel action, and Done action.
- If microphone permission is denied or the streaming setup fails, the screen switches to text entry and preserves any transcript already received.
- Done saves the transcript and returns to the home screen. Cancel deletes the unfinished capture when possible.

## 3. API and data handling

- The token route requires a valid demo session, reads `ASSEMBLYAI_API_KEY` only on the server, and returns a short-lived token with private no-store caching. `STT_TOKEN_TTL_SECONDS` defaults to 120 and is constrained to AssemblyAI’s supported 1–600 second range.
- Draft creation checks that the patient belongs to the current session’s workspace. It inserts a `CAPTURING` draft and its initial revision in a transaction.
- Draft PATCH accepts a non-empty transcript only for an owned `CAPTURING` draft. It moves the draft to `DRAFT`, increments the revision, and records a `transcript_captured` revision snapshot atomically. Repeating the same PATCH after a successful save is safe.
- Draft DELETE only removes an owned draft that is still `CAPTURING`; its revision rows cascade with the draft.
- The browser connects to AssemblyAI Streaming STT v3 using a temporary token, `universal-streaming-english`, and medical mode (`domain=medical-v1`). The API key is never sent to the browser.

## 4. Files changed

- `src/app/api/stt-token/route.ts` — session-protected temporary-token endpoint.
- `src/app/api/drafts/route.ts` — patient-scoped capture creation.
- `src/app/api/drafts/[id]/route.ts` — transcript finalization and unfinished-capture cleanup.
- `src/components/recording-screen.tsx` — recording, transcript, fallback, and save UI.
- `src/components/home-screen.tsx` — opens the recording screen for the selected patient.
- `src/app/globals.css` — waveform animation and reduced-motion handling.
- `.env.example` — documents `STT_TOKEN_TTL_SECONDS` and the Streaming STT token usage.

## 5. Validation

| Check | Result |
|---|---|
| `corepack pnpm --filter @voicecare/web typecheck` | Passed; Next route types generated successfully |
| `corepack pnpm --filter @voicecare/web lint` | Passed |
| `git diff --check` | Passed |
| Live microphone, browser WebSocket, transcription, and draft save | Confirmed by user in browser; transcript appeared and the app showed “Transcript saved” |

The local `.env.local` was confirmed to contain non-empty AssemblyAI and database settings; their values were not displayed. The user confirmed a browser recording produced visible transcription and ended with the “Transcript saved” toast, exercising microphone access, streaming transcription, and the successful draft-save response.

## 6. Implementation notes

- The roadmap’s “medical-v1 model” wording was mapped to AssemblyAI’s current API: `medical-v1` is the `domain` mode, paired here with the supported `universal-streaming-english` speech model.
- No schema migration was required; Stage 1’s existing `drafts` and `draft_revisions` tables support the capture flow.
- The pre-existing edits to `apps/web/package.json` and `pnpm-lock.yaml` were left unchanged.

## 7. Stage 2 exit criteria

The required capture and persistence paths are implemented and were exercised in the browser: live transcription appeared during recording, and Done saved the transcript as a `DRAFT`.
