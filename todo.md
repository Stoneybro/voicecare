# VoiceCare — TODO & Future Roadmap

## 1. Multi-Patient Management (Add & Switch Patients) — DONE this iteration
- [x] **Backend: Patient Creation Endpoint** — `POST /api/patients` scoped to the demo-session caregiver.
- [x] **Patient switcher UI (`demo-app.tsx`)** — pill tabs `[Rosa] [John] [+ Add Patient]`, inline add form, per-patient draft/history/expressions reload via `GET /api/drafts?patient_id=` + token re-mint per patient.
- [x] **Voice Session Dynamic Binding** — streaming-token and voice-token endpoints take `patient_id`; prompt/keyterms adapt per patient.
- [ ] **Patient Deletion / Archive (Optional)** — still open; soft-delete when care is concluded.

## 2. New iteration verification (live)
- [ ] **Live medical streaming check** — Speak 30s with pauses: live captions appear turn-by-turn, Done yields the same words in the agent handoff, fallback transcribe works with streaming blocked.
- [ ] **Two-stage handoff check** — injected transcript triggers `update_draft` + at most the genuine unit questions, then readback.
- [ ] **Exports check** — doctor/family print from deployed URL; JSON/CSV download opens with one row per item.
- [ ] **Two-browser isolation re-check** after new endpoints (`/api/patients`, `/api/voice/streaming-token`, `GET /api/drafts`).

## 3. Developer Experience & UI Polish
- [ ] **Fix Client Hydration Warning** — resolve Next.js SSR/client attribute mismatch on initial page load.
