# VoiceCare — Stage 5 Implementation Report

**Stage:** Review, Correction & Confirmation (spec/02, Stage 5)  
**Date:** 2026-09-27  
**Status:** Implemented; typecheck, lint, and diff checks pass. Live voice confirmation still depends on AssemblyAI Voice Agent access and has not yet been exercised in the browser.

---

## 1. Scope delivered

| # | What | Status | Where |
|---|---|---|---|
| 5.1 | Structured review with editable measurement, observation, and time fields | Complete | `apps/web/src/components/review-screen.tsx` |
| 5.2 | Save caregiver corrections as a new revision | Complete | `PATCH /api/drafts/:id` in `apps/web/src/app/api/drafts/[id]/route.ts` |
| 5.3 | Explicit button confirmation | Complete | `POST /api/drafts/:id/confirm` |
| 5.4 | Voice summary and explicit spoken confirmation | Implemented | Agent config in `apps/web/src/app/api/agent-token/route.ts`; voice flow in `apps/web/src/components/clarification-screen.tsx` |
| 5.5 | Confirmation tied to the current revision | Complete | Confirmation API and existing database constraints |

## 2. User flow

- The review screen now lets the caregiver edit extracted values, units, observations, and observation date/time.
- Saving corrections creates a new `caregiver_correction` revision. It recalculates blocking issues so a missing unit or time stays flagged until supplied; changing the time uses the caregiver’s local timezone.
- Button and voice confirmation are disabled while blocking issues remain. A voice confirmation reads the draft summary and asks for a clear yes; saying no returns the caregiver to review without confirming.
- Successful confirmation sets status to `CONFIRMED`, records `confirmation_method`, `confirmed_at`, and `confirmed_revision`, and appends a confirmation revision snapshot. Confirmed fields are read-only in the review screen.
- Voice confirmation uses the Voice Agent tool-call sequence: the client waits until `reply.done` before sending `tool.result`, as described in AssemblyAI’s [Events reference](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference).

## 3. Data and safety handling

- Corrections only apply to owned drafts in `NEEDS_CLARIFICATION` or `REVIEWABLE`; a revision check rejects stale concurrent edits.
- Every correction clears any confirmation fields and records a new revision, preventing confirmation from drifting onto changed content.
- Confirmation only applies to an owned `REVIEWABLE` draft with no unresolved issues. Voice confirmation additionally requires an explicit affirmative phrase; unclear or negative answers do not confirm.
- The database already contained confirmation fields, status constraints, revision snapshots, and the current-revision check. No schema migration was needed.
- Stage 6 report creation is not included in this stage. When added, it must require `confirmed_at` and match the current confirmed revision.

## 4. Files changed

- `apps/web/src/app/api/drafts/[id]/route.ts` — structured correction validation, unresolved-issue recalculation, stale-edit protection, and revision snapshots.
- `apps/web/src/app/api/drafts/[id]/confirm/route.ts` — button/voice confirmation with ownership and unresolved-issue guards.
- `apps/web/src/app/api/agent-token/route.ts` — confirmation-mode summary and tool configuration.
- `apps/web/src/components/review-screen.tsx` — inline review editing, correction save, confirmation actions, and confirmed state.
- `apps/web/src/components/clarification-screen.tsx` — shared Voice Agent UI now supports both clarification and voice confirmation.

## 5. Validation

| Check | Result |
|---|---|
| `npm.cmd run typecheck` from `apps/web` | Passed |
| `npm.cmd run lint` from `apps/web` | Passed |
| `git diff --check` | Passed |
| Live button confirmation | Not yet tested in the browser |
| Live Voice Agent summary/confirmation | Not yet tested; account access remains unverified |

## 6. What you can test

1. Record a note with a clear reading, for example **“blood pressure was 130 over 80 this morning”**, and finish. On review, change one number and save corrections; the revision should update and the edit should remain visible after reload.
2. Confirm the corrected draft with **Confirm draft**. It should show **Confirmed**, with confirmation method **button** and the confirmed revision.
3. Try a note with a missing glucose unit. Confirmation should stay disabled until you clarify the unit or enter one in the measurement card and save.
4. For a reviewable draft, choose **Confirm by voice**. The agent should read the summary. Say **“no”** and verify it remains unconfirmed; repeat and say **“yes”** to confirm by voice.
5. Change the observation date/time and save, then reload. Check that the displayed local time remains the same.
6. After confirmation, verify the review fields are read-only and further correction/confirmation actions are no longer offered.

## 7. Stage 5 exit criteria

The correction and confirmation flows are implemented and statically validated. Browser verification remains: edit a value, confirm, and check that the draft is `CONFIRMED` with `confirmed_revision` equal to the current revision. Voice confirmation also requires a live Voice Agent session.
