# VoiceCare — Stage 1 Implementation Report

**Stage:** Shell, Session & Workspace Bootstrap (spec/02, Stage 1)
**Date:** 2026-09-24
**Status:** ✅ Complete — lint, typecheck, and production build all green; end-to-end flows verified against a live server on Neon.

---

## 1. Scope delivered (spec/02 stages 1.1–1.7)

| # | What | Status | Where |
|---|------|--------|-------|
| 1.1 | Design system | ✅ | `globals.css` (calm-teal oklch tokens, Inter, `voice-pulse`), 13 shadcn primitives, vendored ElevenLabs `Orb` |
| 1.2 | Home screen layout | ✅ | `src/components/home-screen.tsx` — orb hero, Speak CTA, switcher, history empty state, reset |
| 1.3 | `GET /api/bootstrap` | ✅ | `src/app/api/bootstrap/route.ts` — session + caregiver + 2 patients in one transaction, sets cookie |
| 1.4 | Session middleware | ✅ * | `src/lib/session.ts` — `requireSession()` guard called by every route (divergence explained in §9) |
| 1.5 | Patient switcher | ✅ | Pills + avatars; selection persisted in `localStorage` (`voicecare:last-patient-id`) |
| 1.6 | `POST /api/patients` | ✅ | Trim + 1–60 chars, `409` on duplicate name, returns refreshed workspace |
| 1.7 | Demo reset | ✅ | `DELETE /api/demo` — invalidates old session, returns the fresh workspace in one response |

**Exit criteria met:** open the app cold → workspace appears with two patients, no errors, no login, under 3 seconds.

---

## 2. Architecture at a glance

```
Browser (HomeScreen, "use client")
   │  fetch /api/bootstrap?timezone=…        ← single source of workspace state
   ▼
Route handler (src/app/api/*)
   │  requireSession() → cookie → SHA-256 → demo_sessions (sliding 72 h)
   │  zod validation   → ApiError envelope on any failure
   ▼
lib/{db,session,bootstrap}.ts
   │  @neondatabase/serverless (pooled HTTP driver)
   ▼
Neon Postgres (db/schema.sql)
```

**Stack as built:** Next.js 16.3.5 (App Router) · React 19.3.0 · Tailwind 4.3.3 · TypeScript 5.9.3 strict · Zod 4.6.5 · `@neondatabase/serverless` 1.1.0 · Node ≥ 24 · pnpm 12.4.2.

**Dependencies added in Stage 1:** UI kit (`cn`, `class-variance-authority`, `tw-animate-css`, `@base-ui/react`, `lucide-react`, `sonner`, `next-themes`) and the orb stack (`three` 0.186, `@react-three/fiber` 9, `@react-three/drei` 10, `@types/three`).

---

## 3. Database

- `db/schema.sql` was **applied to the Neon database** via a new utility, `db/apply-schema.mjs` (`corepack pnpm db:apply` from `apps/web`), because the dev machine has no `psql`: it parses `DATABASE_URL_UNPOOLED` (fallback `DATABASE_URL`) from `.env.local`, runs the script as one simple-query batch, and lists the resulting tables.
- Stage 1 exercises only `demo_sessions`, `caregivers`, `patients` — the full schema (drafts, revisions, append-only reports, personal expressions) is already live but idle, so later stages need no migration work.
- Ids are app-generated prefixed strings (`sess_…`, `pat_…`). The cookie's raw token never reaches the database; only its SHA-256 (`token_hash`, unique) does.

---

## 4. Server layer

**`src/lib/session.ts`** — the heart of Stage 1:
- **Token model:** 32 random bytes → base64url cookie value; only `sha256(token)` is stored, so a leaked DB dump cannot be replayed as a session.
- **Cookie:** `vc_demo_session` — HttpOnly, SameSite=Lax, Path=/, Secure in production, rolling 72 h expiry (spec/01). Browsers accept Secure cookies on localhost; CLI tools may not (§8).
- **Bootstrap:** valid un-expired cookie → slide `expires_at`/`last_seen_at` and load the workspace; otherwise create session + caregiver "Demo caregiver" + patients Rosa and John in **one `sql.transaction` batch**, then set the cookie. Timezone is validated against `Intl` (fallback UTC) and stored on first creation.
- **Guard:** `requireSession()` throws typed `ApiError`s — `401 session_required` / `401 session_expired` — with messages that tell the user a reload fixes it.
- **Reset:** marks `invalidated_at`, clears the cookie, creates a brand-new workspace.

**`src/lib/http.ts`** — error contract: `handle()` wraps every route; `ApiError` → `{error:{code,message}}`, Zod failures → readable `400 invalid_request`, DB-not-configured → `503`, anything unexpected → `500 unexpected_error` with a friendly non-leaking message (details only in the server log).

**`src/lib/bootstrap.ts`** — one response shape shared by all routes: `{session:{…,is_new}, caregiver:{…}, patients:[…], reports_count}`. `reports_count` feeds the history badge without a second round trip.

| Route | Verified behavior (live) |
|---|---|
| `GET /api/bootstrap?timezone=` | cold: `is_new=true`, Rosa+John, tz honored · warm: `is_new=false`, same session id |
| `POST /api/patients` | create + full refreshed payload · duplicate → `409 duplicate_patient` · blank → `400 invalid_request` |
| `DELETE /api/demo?timezone=` | fresh session id, back to Rosa+John, old session invalidated |

---

## 5. Client layer

- **`layout.tsx`:** Inter as `--font-sans`, Geist Mono, product metadata ("fictional information only" framing), sonner `Toaster` mounted top-center. `page.tsx` is a 5-line shell rendering `HomeScreen`.
- **`home-screen.tsx`** — deliberately one file, three states:
  1. **Loading** — skeleton echo of the hero (`aria-label="Loading VoiceCare"`).
  2. **Failed** — friendly retry card (TriangleAlert icon + "Try again" button).
  3. **Ready** — header (logo pill + Reset demo) · hero (orb + personalized headline + pulsing Speak CTA + demo disclaimer) · patient pills with initials avatars · "Add person" dialog (Enter submits, 60-char cap, disabled while pending) · history card with `reports_count` badge and expiry rendered in the browser's locale.
- Every mutation swaps the **whole workspace payload** in one `setData`, so the UI can never disagree with the server; server error messages surface verbatim via toasts.
- The Speak CTA intentionally has no handler yet — it is Stage 2's entry point. The orb is already imported and mounted with an `agentState` prop (currently `null`) ready to be driven by recording state.

---

## 6. Validation results

| Check | Result |
|---|---|
| `corepack pnpm typecheck` (incl. Next typegen) | ✅ clean |
| `corepack pnpm lint` | ✅ 0 errors, 0 warnings |
| `corepack pnpm build` (prod) | ✅ 4 routes compiled (/, /api/bootstrap, /api/patients, /api/demo) |
| `node db/apply-schema.mjs` | ✅ tables created on Neon |
| Live e2e (started server, curl-equivalent) | ✅ 8/8 scenarios below |

**Live e2e scenarios (all passed):**
cold bootstrap (`is_new=true`, Rosa+John, timezone honored) → warm reload (same session, `is_new=false`) → add "Maria" (3 patients) → duplicate "Maria" → `409` → empty name → `400` → reset → fresh session, Rosa+John → request without cookie → `401 session_required` → home page → `200`.

---

## 7. Issues hit & how they were resolved

| Issue | Resolution |
|---|---|
| `pnpm dlx shadcn init` broke: pnpm 12's dlx shim can't re-spawn itself on Windows | Installed the init-scaffolded deps with `corepack pnpm --filter @voicecare/web add …`; `components.json` survived |
| ElevenLabs registry (`ui.elevenlabs.io/r/orb.json`) rate-limited (HTTP 429) | Vendored `orb.tsx` straight from their GitHub source into `src/components/ui/` — same file the registry would have written |
| Nine lint errors | 7 were the vendored orb (upstream WebGL/shader code predates the new `react-hooks/refs·purity·immutability` rules) → scoped per-file override in `eslint.config.mjs` with justification · 1 unused type alias → deleted · 1 `setState-in-effect` in my code → verified all setState calls happen after `await`, added an inline documented disable |
| `Secure` cookie + curl over `http://localhost` | curl drops Set-Cookie marked Secure on plain http; PowerShell `Invoke-WebRequest` sessions keep it — used those for the e2e chain |

---

## 8. Environment notes (Windows-specific)

- Long installs (shadcn add, pnpm add of three/@react-three) exceed the 30 s command timeout → run them as background `cmd` processes writing to log files, then poll.
- PowerShell turns pnpm's stderr progress bars into `Commandterminated` errors → wrap real installs in `cmd /c` or background processes.
- `corepack pnpm …` from the repo root is the reliable path for workspace installs (`--filter @voicecare/web`).

---

## 9. Decisions & divergences

1. **`requireSession()` per route instead of Next middleware/proxy (1.4).** Keeps all session logic in one typed module; the spec's intent (no unguarded route) is met because every route calls it, and future stages inherit the pattern. Cookie set/delete stays in route handlers, where Next requires it.
2. **Two fictional patients seeded** (Rosa, John) per the new spec — the old implementation had one.
3. **Reset returns the new workspace in the same response**, so reset is one click with no second fetch.
4. **Timezone is captured once at bootstrap** from the browser and stored on the caregiver; later requests reuse the stored zone (only bootstrap/reset accept the `timezone` param).
5. **`reports_count` rides on every workspace payload** — the history badge stays live in later stages for free.

---

## 10. What Stage 2 builds on this

- `GET /api/stt-token` (single-use AssemblyAI streaming token) — new route reusing `requireSession()`.
- Full-screen recording UI reusing the vendored orb — `agentState` prop is already wired for `listening/thinking/speaking`.
- `medical-v1` WebSocket live transcript → `POST /api/drafts` with transcript persistence (`drafts` + `draft_revisions` tables are live but idle).
- Typed fallback path for judges who can't grant microphone access.

**Repo state:** `apps/web` builds clean; `STAGE-1-REPORT.md` (this file) at repo root; HEAD remains the pre-reset implementation for reference until you choose to commit over it.

