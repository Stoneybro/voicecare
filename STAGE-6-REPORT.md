# VoiceCare — Stage 6 Implementation Report

**Stage:** Save, History & Exports (spec/02, Stage 6)  
**Date:** 2026-09-27  
**Status:** Implemented; typecheck, lint, and diff checks pass. Live database saves and browser downloads/print have not yet been exercised.

---

## 1. Scope delivered

| # | What | Status | Where |
|---|---|---|---|
| 6.1 | `POST /api/reports` with current-confirmation guard, transaction, and idempotency | Complete | `apps/web/src/app/api/reports/route.ts` |
| 6.2 | Patient-scoped chronological history | Complete | `GET /api/reports` and `ReportHistory` |
| 6.3 | Owner-scoped saved report detail | Complete | `GET /api/reports/:id` and `ReportDetailScreen` |
| 6.4 | Doctor summary export | Implemented | Report detail download action |
| 6.5 | Plain-language family summary export | Implemented | Report detail download action |
| 6.6 | Deterministic JSON and CSV downloads | Implemented | Report detail download actions |
| 6.7 | Print layout | Implemented | Report detail print action and existing `#print-summary` print styles |

## 2. User flow

- From a confirmed review, the caregiver chooses **Save report**. A stable idempotency key is reused for retries from that screen.
- The server snapshots only a fully confirmed current revision, inserts the immutable report, then updates the draft’s `current_report_id` and status to `SAVED` in a database transaction.
- The caregiver is taken to the saved report. On the workspace, History lists reports for the selected patient newest first.
- Opening a history entry shows measurements, observations, observation time, and the original transcript. Doctor/family text, JSON, and CSV downloads plus browser print are available there.

## 3. Data and safety handling

- All report reads and writes are scoped to the current demo caregiver; patient filtering is checked against the same session.
- Save is rejected unless the draft is `CONFIRMED` or already `SAVED`, `confirmed_at` is set, `confirmed_revision` equals the current revision, and there are no unresolved issues.
- A canonical SHA-256 content hash is stored with each immutable report. Reusing an idempotency key with different content returns a conflict; the schema’s unique draft/revision constraint prevents duplicate reports for one confirmed revision.
- The report insert and draft pointer/status update are sent in one Neon transaction. Existing schema constraints enforce the report-to-draft, owner, revision, and current-report relationships. No schema migration was needed.
- Exports are generated from the saved report snapshot, not from the mutable review form.

## 4. Files changed

- `apps/web/src/app/api/reports/route.ts` — idempotent report save and patient-scoped report listing.
- `apps/web/src/app/api/reports/[id]/route.ts` — session-owned immutable report detail read.
- `apps/web/src/components/report-screens.tsx` — report history/detail, doctor/family summaries, JSON/CSV downloads, and print action.
- `apps/web/src/components/review-screen.tsx` — idempotent Save report action after confirmation.
- `apps/web/src/components/home-screen.tsx` — saved-report history for the selected patient and report-detail navigation.

## 5. Validation

| Check | Result |
|---|---|
| `npm.cmd run typecheck` from `apps/web` | Passed |
| `npm.cmd run lint` from `apps/web` | Passed |
| `git diff --check` | Passed |
| Live Neon report transaction/history | Not yet tested |
| Browser downloads and print preview | Not yet tested |

## 6. What you can test

1. Record a note with a clear value and time, complete any clarifications, review it, and confirm it.
2. Choose **Save report**. It should open the saved report detail and show that report in History for the selected patient.
3. Return to the workspace and switch patients. Confirm each patient’s history shows only their own reports; switch back and open the new report.
4. Download **Doctor summary**, **Family summary**, **JSON**, and **CSV**. Open the files and confirm they contain the saved values and observations. Download JSON/CSV twice and compare their contents for stable serialization.
5. Choose **Print** and inspect the browser print preview for a clean report without navigation controls.
6. To check idempotency from the browser console, repeat `POST /api/reports` for the same confirmed `draft_id` with the same `Idempotency-Key`: it should return the same report ID. Reusing that key for different content should return a conflict.
7. Try saving a draft that is not confirmed or still has unresolved issues. The server should reject it and create no report.

## 7. Stage 6 exit criteria

The save, history, detail, export, and print paths are implemented and statically validated. End-to-end browser verification remains: save a confirmed draft, find it in history, and exercise all three export formats plus print preview.
