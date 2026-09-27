# VoiceCare — Stage 7 Implementation Report

**Stage:** Personal Expressions Memory (spec/02, Stage 7)  
**Date:** 2026-09-27  
**Status:** Implemented; typecheck, lint, and diff checks pass. Live database and browser flow remain to be exercised.

## What was delivered

| Requirement | Result | Where |
|---|---|---|
| Detect an explicit, reusable phrase-to-measurement mapping after a resolved clarification | Implemented with a conservative matcher; glucose and temperature suggestions require a stated unit | `apps/web/src/lib/expressions.ts`, `api/drafts/[id]/clarify` |
| Ask the caregiver before remembering | Added a “Remember this?” card with separate **Yes, remember** and **Not now** choices | `components/clarification-screen.tsx` |
| Save patient-scoped memory with confirmation timestamp | Added `POST /api/expressions`; it validates the suggestion against the caregiver-owned draft’s resolved clarification log and sets `confirmed_at` on explicit confirmation | `api/expressions/route.ts` |
| Use saved phrases during extraction | New captures, clarifications, and corrections load active expressions scoped to the caregiver and patient; values normalize to a measurement type and retain the phrase in source text | `lib/extraction.ts`, `lib/expressions.ts`, draft routes |
| Manage remembered phrases | Added a **Remembered phrases** screen and owner-scoped soft-delete endpoint | `components/personal-expressions-screen.tsx`, `api/expressions/[id]` |

No schema migration was needed: the existing `personal_expressions` table already provides patient scope, `confirmed_at`, and soft deletion. No phrase is saved from inference alone, and the confirmation endpoint will not accept an arbitrary client-supplied mapping.

## Validation

| Check | Result |
|---|---|
| `npm.cmd run typecheck` from `apps/web` | Passed |
| `npm.cmd run lint` from `apps/web` | Passed |
| `git diff --check` | Passed (Git printed line-ending normalization warnings only) |
| Automated unit tests | None are configured in this app |
| Live database / end-to-end browser test | Not yet exercised |

## What you can test

1. Start with a fresh or existing demo patient. Record a phrase with an explicit mapping and a value but omit the time, for example: “Pulsera means heart rate. It was 88.”
2. When VoiceCare asks when it was observed, answer “this morning.” After that clarification resolves, check for **Remember this?**. Choose **Not now** and verify the flow does not remember the phrase.
3. Repeat with the same explicit mapping and choose **Yes, remember**. Open **Remembered phrases** from the home screen and confirm it lists “pulsera” as heart rate for that patient.
4. Start a new recording for the same patient and say “Pulsera 88 this morning.” Confirm it extracts heart rate without asking what “pulsera” means. Check that the review/source text still shows the caregiver’s phrase.
5. Switch to another patient and confirm the first patient’s phrase is not applied. Switch back and delete it from **Remembered phrases**; a later recording should no longer use that mapping.
6. Try a glucose or temperature mapping without its scale. VoiceCare should not offer to remember it until the mapping includes a unit, such as mg/dL or Celsius.

The Stage 7 flow is implemented and statically validated. The exit criterion still needs your end-to-end check: explicitly accept a phrase, start a new recording, and verify it resolves without a clarification.
