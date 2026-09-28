# Natural-language extraction implementation report

## Outcome

VoiceCare now has a server-side Gemini extraction path intended to better handle ordinary caregiver speech, including multiple observations in a single unpunctuated sentence. Gemini 3.1 Flash-Lite is the configurable default. The deterministic parser remains as a fallback when the provider key is missing or the provider request fails, and the original transcript remains available for comparison during review.

## Model choice

Start with [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite): Google describes it as a low-latency, cost-efficient model for lightweight processing and data extraction, and it supports [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output). The listed paid-tier token rates are $0.25 per million text input tokens and $1.50 per million output tokens on Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing). The model can be changed through `GEMINI_EXTRACTION_MODEL`; evaluate recall and accuracy on a representative VoiceCare test set before choosing a larger model.

## What changed

- Added `apps/web/src/lib/llm-extraction.ts` to request schema-constrained JSON containing measurements, observations, their exact transcript snippets, confidence, and observation-time information.
- Added conservative validation: a returned detail is accepted only when its cited source text appears in the transcript. Missing/uncertain units and values remain flagged; the extractor is instructed not to diagnose, advise, or invent units.
- Observation time now defaults to the server-created draft/recording time. A model-generated timestamp is used only when it cites an explicit temporal phrase found in the transcript. Date-only phrases such as “two days ago” retain the recording's local time of day rather than inventing an hour. Capture, clarification, and correction re-extraction all use the same original recording timestamp.
- Draft capture and clarification now use this extraction service. Provider errors fall back to the existing parser so capture remains available.
- Added `GEMINI_API_KEY` and `GEMINI_EXTRACTION_MODEL` documentation to `apps/web/.env.example`. No secret was added to the repository.
- The review screen now warns when no Gemini key is configured, and observation cards display their supporting transcript snippet.
- Updated Stage 3 in `spec/02-development-stages.md` to match this hybrid design.

## Verification

- `npm.cmd run typecheck` — passed.
- `npm.cmd run lint` — passed.
- `git diff --check` — passed.
- Before the provider switch, the extraction logic passed a mocked response for a multi-clause example with blood pressure, glucose, leg pain, and “3 days ago.” The Gemini transport change has passed typecheck and lint, but its provider response has not yet been exercised with a live key.
- Timestamp guard test: a mocked Gemini result that returned a date with no time source was replaced with recording time; “two days ago” resolved to the earlier date at the recording's time of day in `Africa/Lagos`. The deterministic fallback produced the same relative-date result.
- A live Gemini request could not be tested because `GEMINI_API_KEY` is not configured in this workspace.

## What to test

1. Add your Gemini API key to `apps/web/.env.local` locally (do not share it in chat) and restart the web app. The review-screen fallback warning should disappear.
2. Record a multi-clause example such as: “Rosa's blood pressure was 120 over 80, her blood sugar was 60, and her leg was paining her.” Confirm the observation time matches when you started recording, not when transcription finished.
3. Repeat with “This happened two days ago.” Confirm the date is two days before the recording date and, because no time of day was stated, uses the recording's time of day.
4. Confirm that glucose remains flagged for its unit instead of being silently assigned one. Use clarification to supply the unit and time, then check that the pain observation is still present.
5. Edit a detail, save, and confirm the draft; check that the saved report/history still includes the observation.
6. For fallback behavior, run without the key and confirm the review screen warns that advanced speech understanding is unavailable and still shows the full transcript. The fallback parser is not expected to capture every natural-language phrase.

## Limitation and privacy note

The app currently falls back to the small parser without surfacing whether a provider request failed transiently after a key is configured; the missing-key case is clearly labeled. The model path also needs evaluation on a representative set of accents, speech-recognition errors, and multi-observation examples before being treated as reliable. Google's pricing page distinguishes data use by tier: requests on its free tier may be used to improve products, while paid-tier data is not; confirm the terms for the account you use. This is a prototype: do not send real patient data to an external model until the product's data-handling terms, privacy safeguards, and applicable compliance requirements have been reviewed.
