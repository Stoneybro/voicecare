# VoiceCare — Stage 4 Implementation Report

**Stage:** Stage 2 Voice — Clarification Agent (spec/02, Stage 4)  
**Date:** 2026-09-27  
**Status:** Implemented; typecheck, lint, and diff checks pass. Live Voice Agent account access and browser conversation have not yet been verified.

---

## 1. Scope delivered

| # | What | Status | Where |
|---|---|---|---|
| 4.1 | `GET /api/agent-token?draft_id=...` | Complete | `apps/web/src/app/api/agent-token/route.ts` |
| 4.2 | Server-built clarification prompt and session config | Complete | `apps/web/src/lib/clarification.ts` and token route |
| 4.3 | Voice clarification screen | Implemented | `apps/web/src/components/clarification-screen.tsx` |
| 4.4 | `POST /api/drafts/:id/clarify` | Complete | `apps/web/src/app/api/drafts/[id]/clarify/route.ts` |
| 4.5 | Re-extraction and next-question loop | Implemented | Clarification endpoint and Voice Agent tool-call flow |
| 4.6 | Leave unresolved and return to review | Implemented | “Finish and review” preserves open issues on the draft |

## 2. User flow

- When a draft has blocking unresolved details, its review screen offers **Clarify with voice**.
- Starting clarification requests an owner-scoped, single-use AssemblyAI Voice Agent token. The server also returns the prompt and session configuration for the browser’s initial `session.update`.
- The caregiver hears one question at a time and answers aloud. The agent submits the answer through a tool call; the app records it and re-runs extraction before the agent continues.
- If all blocking issues are resolved, the draft becomes `REVIEWABLE`. If an issue remains unclear, it stays flagged and the agent can ask again.
- **Finish and review** ends the voice session while leaving unanswered issues unresolved, so clarification can be attempted later.

## 3. API and data handling

- The token route requires a valid demo session and a draft owned by that session. It uses the server-only `ASSEMBLYAI_API_KEY` and sends a Bearer-authenticated request to AssemblyAI’s Voice Agent token endpoint.
- `VOICE_AGENT_TOKEN_TTL_SECONDS` and `VOICE_AGENT_MAX_SESSION_SECONDS` are constrained to AssemblyAI’s documented ranges. The route returns private no-store responses and does not expose the API key.
- Clarification answers are checked against the current unresolved issue and draft revision. The answer, question, resolution result, updated extraction, and revision snapshot are written in one database statement. Concurrent changes are rejected rather than overwritten.
- The Voice Agent session ID is saved to the draft for troubleshooting. Existing `clarification_log`, `drafts`, and `draft_revisions` columns support the implementation; no schema migration was needed.
- The Stage 4 plan in `spec/02-development-stages.md` now reflects that prompt/config are sent in `session.update`, not embedded in the token. Its exit example now uses a glucose value without units; blood pressure readings use mmHg.

## 4. Files changed

- `apps/web/src/app/api/agent-token/route.ts` — authenticated single-use Voice Agent token and session config.
- `apps/web/src/app/api/drafts/[id]/clarify/route.ts` — answer validation, extraction, audit log, and revision update.
- `apps/web/src/lib/clarification.ts` — prompt builder and deterministic clarification amendments.
- `apps/web/src/components/clarification-screen.tsx` — microphone capture, WebSocket audio streaming/playback, tool calls, and session cleanup.
- `apps/web/src/components/review-screen.tsx` — voice clarification entry point and reload after the session.
- `spec/02-development-stages.md` — corrected Stage 4 endpoint/config and exit-criteria details.

## 5. Validation

| Check | Result |
|---|---|
| `npm.cmd run typecheck` from `apps/web` | Passed |
| `npm.cmd run lint` from `apps/web` | Passed |
| `git diff --check` | Passed |
| Live AssemblyAI Voice Agent session | Not yet tested; account entitlement and browser microphone conversation remain to be confirmed |

## 6. What you can test

1. Record a note such as **“blood glucose was 130 today”** and finish the recording. The review should show a missing glucose unit.
2. Choose **Clarify with voice**. The agent should ask whether the reading was in mg/dL or mmol/L. Answer **“mmol per litre”** (or **“mg per decilitre”**); the updated review should show the chosen unit and no longer list that issue.
3. If you have another unresolved issue, check that the agent asks about it next, one question at a time.
4. Start another clarification and choose **Finish and review** before answering. The issue should remain visible as unresolved.
5. Try a blood-pressure note such as **“blood pressure was 130 over 80 today”**. It should not ask for glucose units; blood pressure is represented in mmHg.

If token creation or the WebSocket fails, note the on-screen error and check that the AssemblyAI account has Voice Agent access. The code is in place, but Streaming STT access alone does not establish that Voice Agent access is enabled.

## 7. Stage 4 exit criteria

The planned flow is implemented. The exit criteria still need a live browser check: a glucose value without a unit prompts for the unit, the caregiver’s answer is logged and re-extracted, and the issue resolves (or remains flagged if the answer is unclear).
