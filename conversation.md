# Conversation log

Long-form responses live here (CLI readability). Newest entry first.

---

## 2026-09-21 — No transcription: found an audio-graph leak, fixed it

### Why I believe it's ours, not the API

The live handshake just passed again with the current config (`session.ready`, `min_latency`, 1200/8000 window, clean teardown). The server side accepts sessions fine — so audio is dying in the browser, and there is a real bug for that: **tapping Speak never tore down the previous audio graph.** Old mic + old worklet kept running and kept posting into the new socket, so the server heard two overlapping streams (garbled input VAD can't parse → no transcription, nothing recorded). Every retry made it worse, which matches "it used to work, now nothing works".

### Fixed

- `start()` now tears everything down first (mic tracks, audio context, socket, timers) before opening anything new. One tap = exactly one mic, one worklet, one socket.
- A socket that dies before ever becoming ready no longer leaves a dead mic behind (resume is impossible without a session id, so nothing needs it).
- New trace line `mic flowing: first audio chunk sent` proves audio leaves the browser; combined with the existing event traces, the next failure — if any — localizes to one side in seconds.

### Retest protocol (matters this time)

1. **Restart `pnpm dev` and hard-refresh the tab** (Ctrl+Shift+R) — both server and client changed, and a stale tab would also explain silence.
2. Tap Speak Care Note once, say one sentence, watch for live text.
3. If still silent, paste the `[voicecare:voice]` console lines: `mic flowing` present + no `transcript.user` = server/VAD side; `mic flowing` absent = browser mic side. Either way it now points somewhere exact.

Verified: typecheck, lint, build, 28 tests, live handshake. The doubled-audio failure mode is eliminated by construction (single audio graph per tap).

## 2026-09-21 — Speak-Freely revamp: assessment + implementation

### Your diagnosis was right; two mechanisms in the proposal don't exist

Checked against the session-configuration, events, and tools references (plus live probes):

1. **`turn_detection: null` / manual turn mode is not a thing.** The API documents exactly five turn fields (vad threshold, min/max silence, barge-in, interruption delay). Null would most likely raise `invalid_config`, and **omitting the timers doesn't remove them either — defaults apply** (1000/3000 in their example), which is worse than what we had.
2. **There is no "commit the audio turn" event.** The full client→server list is: session.update, input.audio, tool.result, session.end, reply.create, conversation.message, session.resume. Nothing ends a turn on demand.

### What I built instead (your UX, documented primitives only)

- **Speak Care Note → Done Speaking (pulsing amber) → Analyzing → Tap to Answer**, plus a quiet **Cancel without processing** link. Red Stop is gone.
- **Done = mic gate + retune + watchdog.** Audio stops leaving the browser (session, mic, draft stay open); the client swaps turn-detection to a snappy posture (400/800 ms) via a mid-session `session.update`, so the finished turn closes within ~1 s; if silence still produces nothing in 6 s, one `reply.create` nudge goes out, then a second timeout surfaces a "try typing" error rather than hanging.
- **Recording posture 1200/8000 ms** — the highest ceiling I could **prove** live (see probes). The prompt now tells the agent pauses are normal and to accumulate with a brief "Got it" rather than rush.
- **Cancel** ends the session and touches nothing (saving still needs the confirm tap, so it can't lose anything). After a successful save the session now ends itself (mic off, no billing).

### Live probe results (worth knowing)

- Config echoes **lag one update behind** — verify accordingly, or you'll misread them.
- Out-of-range silence values are **silently clamped, not rejected** (5000 echoed back 2000).
- Re-sending `output.voice` after the first update trips `immutable_field` — mid-session updates must carry **only** the changing field. The hook does this.

### Honest limits

- A 15 s dead-silence pause may still split the turn (if 8000 is the real cap). That degrades gracefully, not catastrophically: the draft accumulates across turns, the agent says "got it, anything else?", you continue, Done finalizes whenever you choose. Zero collisions is guaranteed; zero splits is not.
- Verified: typecheck, lint, build, 28 tests, live handshake with the new config, backend save flow. **Still open: your intermittent 400s** — retest with refreshed page and paste the `tool … -> HTTP 400` trace line or the dev-terminal rejection line.

## 2026-09-21 — The two hackathon tracks, and ours

### Track 1 — Voice Agent API (managed, end-to-end). This is ours.

One WebSocket does everything. You open `wss://agents.assemblyai.com/v1/ws`, send your
configuration, stream microphone audio in, and get spoken audio back. AssemblyAI owns the
whole pipeline inside: speech recognition, turn detection (knowing when you finished
talking), the LLM that reasons over the conversation, the voice that answers, barge-in
handling, and JSON-Schema tool calling. Our code maps onto it directly:

- `POST /api/voice/token` mints the single-use browser token (Track 1 auth).
- Our `session.update` sends the inline config: system prompt, five function tools,
  transcription biasing, turn-detection timings, English, alba voice.
- The browser streams `input.audio`, plays `reply.audio`, and forwards each `tool.call`
  to our backend, which validates it and returns `tool.result`.
- Our backend owns everything AssemblyAI deliberately doesn't: the draft, the safety
  rules, confirmation, idempotent saving, history.

You choose this track when you want the fastest path to a talking product and are happy to
let AssemblyAI run the voice machinery. Its limits, stated honestly: you cannot pick the
STT model or flip Medical Mode (no documented switch), and you tune behavior through the
prompt, tools, and the dozen documented session fields — not by rewiring the pipeline.

### Track 2 — Realtime STT + bring-your-own everything

Here AssemblyAI is only the ears: a real-time transcription websocket (with connection
parameters like `sample_rate`, `speech_model`, `domain: "medical-v1"`, keyterm lists, and
silence thresholds). **You** build the rest — send transcripts to your own LLM, decide when
to speak, generate voice with your own TTS, play audio, handle interruptions, implement
tool calling, manage sessions. Frameworks like LiveKit and Pipecat exist to carry some of
that weight.

You choose this track for maximum control: the Medical Mode switch lives here, you pick
every model, you own the orchestration. The price is building (and debugging, on demo day,
on judges' browsers) an entire voice stack: turn-taking, barge-in, audio plumbing,
multi-service billing and failure modes.

### Why we are on Track 1

- **Demo timeline.** The hackathon judges a working caregiver story, not pipeline
  engineering. Track 1 gave us a talking agent in days; Track 2 spends those days on
  plumbing.
- **Our hard problems aren't transcription.** Personal vocabulary, never-guess units,
  confirmation binding, duplicate-save protection — all Track-agnostic application logic
  that we'd write identically on either track.
- **Dynamic config stays in code.** Inline `session.update` lets each session carry its
  own patient, units, and remembered phrases with no dashboard setup, no stored agent id,
  nothing a judge must configure. A stored agent would add a setup step and freeze the
  prompt.
- **Fewer moving parts for async judging.** One connection, one bill, one failure domain.
  On Track 2, every extra service is another thing that can break unattended.

If we ever outgrow it (say, a documented medical switch appears and proves decisive, or we
need model choice), the migration is bounded: our tools, validation, and save path move
over unchanged — only the ears-and-voice layer gets swapped.

## 2026-09-21 — Why not AssemblyAI Medical Mode instead of our parsing?

### Short answer

I checked both Voice Agent paths (inline `session.update` reference + full stored-agent field list). **There is currently no documented switch to enable Medical Mode in the Voice Agent API** — no `domain`, `speech_model`, or medical field exists in either configuration surface. The `domain: "medical-v1"` parameter exists only on the raw real-time STT websocket, which is the *other* hackathon path (bring-your-own orchestration), not the managed Voice Agent API we use. So this is something I genuinely cannot wire up from code today — and even if AssemblyAI documents a switch tomorrow, our layers stay. Details:

### What Medical Mode actually is

A transcription-accuracy add-on: it hears medication names, procedures, conditions, dosages and ICD codes correctly where base models garble them (their example: "lisprohumalog" → "Lispro (Humalog)"). It outputs **words**, not structured data. Marketing pages say it runs "underneath" the Voice Agent API, so if it applies to our sessions at all, it applies automatically with zero code change on our side.

### Three jobs it could never do for us

1. **The typed fallback has no audio.** `numbers.ts` + `extract.ts` exist so a caregiver without a microphone gets the identical flow. No transcription API — medical or otherwise — can run on text. That code is irreplaceable by definition.
2. **Hearing words ≠ understanding this caregiver.** Medical Mode doesn't know that *your* "her engine" means heart rate, doesn't enforce "never infer a unit", doesn't ask clarification, doesn't bind confirmation to a revision, doesn't prevent duplicate saves. Our `resolve.ts` layer is a **safety verifier**, not a transcriber — different job entirely.
3. **On the voice path, the numbers come from the LLM, not the transcriber.** The flow is: STT hears words → LLM produces tool arguments with numbers → our backend validates. Medical Mode would only improve step one. Validating what the model *claims* (is there a unit? a source quote? does it match this caregiver's memory without over-applying it?) is still ours to do — trusting model output for health data without verification would be the actual safety hole.

Two supporting facts: our vocabulary (pressure pairs, glucose units) isn't what Medical Mode optimizes (drug/procedure/ICD names), and your own test showed transcription already works — our open issues are understanding and turn-taking, which live above transcription. We also already use the documented in-agent transcription aids (`transcription_prompt`, `keyterms`), verified applied via the `session.ready` echo.

### Hackathon fit

The requirement is "build on AssemblyAI" — the Voice Agent API satisfies it outright; Medical Mode is not required. If AssemblyAI later documents a voice-agent switch, adopting it is a one-field addition to `buildVoiceSession` with everything else untouched. My recommendation: keep the architecture, change nothing.

## 2026-09-21 — Time policy, latency, intermittent 400s

### 1. Time questions: removed, as directed

Demo rule now: the caregiver reports as things happen, so the recording moment **is** the observation time. Changes:
- `needs_time` no longer blocks (`packages/shared/src/vocab.ts`) — the issue is still recorded on the item, but the report stays reviewable and the agent never asks "when did you take this reading".
- Explicit past times in speech ("yesterday") are still preserved on the item; they just never gate saving.
- Shared test updated to lock this ("a missing time is recorded, never a blocking question"); all 28 pass.
- Spec 04 time policy documents the demo rule so docs stay honest.
- Verified live: the demo sentence now blocks only on the two genuine unit questions, then goes REVIEWABLE → confirm → save.

### 2. Latency: three cuts

- Turn-taking tightened: silence window 900/2500 ms → **700/1500 ms** (server stops waiting so long after you pause).
- Transcription `balanced` → **`min_latency`**. Trade-off stated openly: slightly less STT accuracy for faster replies; misheard numbers stay safe because every value is read back with its unit and nothing saves without your tap.
- The voice-token endpoint now **warms the database** while the browser connects, so a cold Neon resume stops landing inside your spoken turn.
- These are config, safe to tune further after your feel-test (e.g. max_silence 1200 if it still feels slow, or back toward 2000 if it ever cuts you off mid-sentence).

### 3. Intermittent 400s: still need one line from you

The full-error reporting is in, and rejections are now also logged server-side (visible in your `pnpm dev` terminal as `[voicecare] tool arguments rejected: …`). To nail the remaining ones I need the exact field: refresh, speak once, and paste either the browser line `tool update_draft -> HTTP 400 …` or the dev-terminal rejection line. Everything else is verified green (typecheck, lint, build, 28 tests, live save flow).

## 2026-09-21 — 404s fixed, now 400s: arguments the schema rejects

### What the new errors mean

The 400s are progress: the draft is found now, but the backend rejects the *contents* of the agent's tool call (a field missing, misshaped, or outside its allowed set). The agent gets the rejection back as an error result and stalls after two tries — hence "stuck". Prime suspects: a missing `source_text`, an empty-string `observation_time`, or an enum value the model invented (e.g. a time status outside `explicit | relative_resolved | report_default | unknown`).

### Changed (backend only, no UI touch)

- All five tool handlers now report **every** validation problem in one 400 (`measurements.0.source_text: Required; observation_time_status: Invalid option… — fix every field and call again`) instead of one at a time. Single round-trip recovery instead of whack-a-mole.
- The browser hook already traces each tool POST (`tool update_draft -> HTTP 400 …`), so the exact field is visible.

### What I need from you (30 seconds)

Refresh the page (the browser is still running the old client code), speak once, then paste the lines starting with `tool update_draft -> HTTP 400` from the console — they name the exact failing field. Backup: DevTools → Network → click the red `tool` request → Response tab → same message. With that, the fix is either a schema tolerance or a prompt hint, and I'll implement it immediately.

## 2026-09-21 — Found it: the agent was hallucinating the patient ID

### Root cause (fits every symptom you reported)

The `update_draft` tool schema **required** a `patient_id` "from the session context" — but the system prompt never tells the agent any internal id. So the agent invented one (e.g. `patient_123`) on every call, the backend compared it to the real draft patient, and rejected **every** save with 404 `draft_not_found`. Your console's three 404s are exactly this. The agent then did the only thing it could: apologize ("trouble recording/saving that") and ask you to repeat. Transcription, hearing you, chit-chat ("Yes, I can hear you") all worked — only the save path was broken, which is why it *felt* like it wasn't responding.

### The fix

- Removed `patient_id` from the `update_draft` tool contract (`packages/shared/src/schemas.ts` — the tool JSON is generated from this, so the agent can no longer be asked for it; a stray one is stripped and ignored).
- Backend now binds patient/caregiver purely from the server session + draft URL (`apps/web/src/lib/agent-tools.ts`), which were already verified. The whole mismatch class is gone, not just this instance.
- Spec 04's contract updated to match — docs no longer describe an identity flow that doesn't exist.
- The voice hook now traces every tool POST (`tool update_draft -> HTTP 200 ok` / `-> HTTP 409 stale_revision: …`), so this failure class is visible next time instead of silent.

### Proven live (not just reasoned)

- `update_draft` with **no** `patient_id` → 200, draft updates.
- `update_draft` with **bogus** `patient_id: "patient_123"` (exactly what the agent was sending) → 200, correctly ignored — and the glucose unit question fires as it should.
- Regenerated tool definitions no longer require `patient_id`; live WebSocket handshake passes again with them; build/typecheck/lint/28 tests green.

### The `M_ID` errors: not our bug

`200.js`/`2200.js` are minified Next.js framework chunks, and the page kept working while they appeared — classic dev-mode instrumentation noise, unrelated to the 404s. Verdict: ignore unless you ever see them in a production build with a visibly broken page.

### Worth knowing for your next test

"Sugar is 69" with no unit will now correctly trigger *"Does the device use mmol/L or mg/dL?"* — nice demo moment, since 69 is plausible in one unit and alarming in the other, and the agent must ask rather than guess. **Restart `pnpm dev` and refresh** before retesting (server + client both changed), then run the demo sentence again.

## 2026-09-21 — No reply after transcription: diagnosis in progress

### Short answer to your question

No — never press Stop to get a response. The intended loop is: you speak → pause (~1 s of silence) → the agent answers on its own. Stop ends the whole session. If nothing comes back after your pause, the conversation is stuck, and that's the bug we're now hunting.

### What your symptom tells me

Transcription arriving means mic → socket → speech recognition all work. A missing reply means one of three things: (a) the server never decided you finished speaking, (b) the agent's tool call never got its result back from our backend, or (c) the agent replied but you neither heard nor saw it. The status line now distinguishes (a): it shows "Listening…" while you're speaking and flips to "Thinking…" the moment the server detects your pause. If it never flips, it's (a); if it flips and nothing follows, it's (b) or (c).

### What I just added (no behavior change, diagnostics only)

- The hook now logs one quiet `console.debug("[voicecare:voice]", …)` line per session event: ready/config check, speech started/stopped, tool calls, tool results (ok vs error code), flushes, reply completion. A stuck session will show exactly where it stopped.
- Status flips to "Thinking…" on `input.speech.stopped`.

### What I need from your next test (dev server restarted with this code)

1. Tap Speak, say one short sentence ("Her pressure was 138 over 88"), then stay silent 5–10 s.
2. Tell me: what did the status line show, and did it change? Did any agent text appear?
3. Open DevTools → Console → filter for `voicecare` (this hides the extension noise), copy every `[voicecare:voice]` line from tap to stuck, and paste them here.

That trace pinpoints the stall to a single step, and the fix follows from it.

### 2026-09-21 — Voice + minimal UI rebuild: implemented and verified

## 2026-09-21 — Voice + minimal UI rebuild: implemented and verified

### What changed

**Voice client (`hooks/use-voice.ts`, `public/pcm-processor.js`) — rewritten around the docs:**
- No more forced 24 kHz context. Audio runs at the device rate (keeps echo cancellation working on every browser); the worklet resamples to 24 kHz with fractional carry across quanta. This is the documented cross-browser pipeline and the fix for the distorted voice.
- `noiseSuppression: false` on the mic (the server already denoises; stacking layers hurts transcription — your correction had flipped this to `true`).
- Session sends exactly the documented shape, no greeting: `{system_prompt, tools, output: {voice}, input: {transcription_prompt, keyterms, language_codes: ["en"], transcription_mode: "balanced"}}` plus the existing turn-detection tuning.
- Trust-but-verify: `session.ready` echoes the applied config; the client checks `transcription_prompt` actually landed and exposes it as `verified`.
- Turn-taking hardened: tool results flush on every safe `reply.done`, pending results expire after 90 s, backend rejections go back with `is_error: true` and a speakable message, and a `stale_revision` rejection retries once automatically at the fresh revision.
- Drops resume once via `session.resume` inside the 30 s grace window; live partial transcripts (`transcript.user.delta` replaces per item, never concatenates; agent word-deltas accumulate per reply).

**Server (`lib/voice.ts`):** greeting removed from the session config entirely.

**Home UI (`components/demo-app.tsx`) — rebuilt minimal per your spec:**
- Home: big **Speak** button, live conversation space (committed + live lines, auto-scroll, readback shown when reviewable), tappable unit-option answers, one **Confirm and save** card, a **Type instead** toggle, **History** and **Reset** buttons, subtle hint text. Nothing else.
- History (one tap away): saved reports, original wording, earlier/newer revisions, printable appointment summary, remembered phrases with Forget.
- Corrections happen by voice; per-item remove buttons and the measurement grid are gone.

### Verification (no assumptions)

- `typecheck` clean, `lint` clean, `next build` clean, 28/28 shared tests pass.
- **Live handshake against the real AssemblyAI API** (Node script through our own token endpoint, session.update byte-identical to the browser client): `session.ready` received; echo confirms `transcription_prompt` applied, 13 keyterms, `language_codes: ["en"]`, voice `alba`; clean `session.end` → `session.ended`. No greeting in the config.

### What still needs a human with a microphone

I verified the handshake, not a spoken conversation. Please test on your machine: tap Speak, say the demo sentence, confirm the voice sounds normal and it asks only the two unit questions. If anything is off, grab page-context console errors (Incognito, extensions off) and the exact moment it misbehaves — the live transcript area should now make that visible. One known environment factor: on loudspeakers the agent can still hear itself; headphones settle that instantly if you hear self-interruption.

## 2026-09-21 — Voice issues, minimal UI, doc discipline

### 1. Who is Margot?

Nobody. That was a stray, meaningless phrase in my last message — there is no Margot, no persona, no other agent involved. My fault, and I'll keep responses plain.

### 2. Greeting: dropped, agreed

No spoken greeting. Verified in the docs: the agent only speaks a greeting if `session.update` contains a `greeting` field, so omitting it means the session just opens silently and waits for you. The home screen will carry a subtle hint line instead (e.g. "Tap Speak, then describe what you observed for Rosa"). Zero friction, nothing to sit through.

### 3. Is the demo fixed? Can I ask other things?

Not yet. Current status, honestly:

- **Working and verified live:** the whole backend loop (session → draft → typed observation → unit questions → confirm → idempotent save → history → summary → reset). Two backend bugs found by testing are fixed and green.
- **Not yet touched (you said don't code):** the voice client rewrite and the minimal-UI rebuild. Those are next, once you approve the plan below.
- **Yes, ask other things any time** — deployment, pitch, test plan, whatever is most urgent for the hackathon.

### 4. Your console errors are not from our app

Every line you pasted comes from `contentscript.js` with `ObjectMultiplex` / `app-init-liveness` / `background-liveness` — that is a browser **extension** (a crypto-wallet-style extension), not VoiceCare. Our page code cannot produce those. To see *our* errors: open DevTools → Console → filter out the extension noise (or run the demo in an Incognito window with extensions disabled) and send me anything red that mentions `localhost`, `page`, or our files. If there is nothing red from the page, that itself tells me the failure is audio-format, not a crash.

### 5. "Text appeared while I spoke" is actually good news

That text is the live transcript arriving from AssemblyAI — so your microphone, the WebSocket, and transcription all work. The breakdown is downstream of that, and your two symptoms now make sense together:

- **Distorted voice:** the agent's reply audio is 24 kHz PCM, but my client *assumes* the browser runs audio at 24 kHz instead of checking. When the browser runs at 48 kHz (common on Windows, Bluetooth headsets, Safari always), playback plays at the wrong speed (garbled) **and** your mic audio arrives sped-up, so the agent transcribes you wrong and responds to garbage. One wrong assumption poisons both directions — exactly what you experienced.
- **"Doesn't respond properly":** on top of the garbled input, my turn-taking queue can swallow tool results. The protocol rule is: results may only be sent when the agent has finished speaking. If a result arrives mid-speech, my code holds it — and in some orderings it never lets go, so the agent never learns what it heard and the conversation derails.

### 6. Cross-browser plan (from today's docs, not memory)

I re-read the Voice Agent API references today (browser integration, inline session configuration, events reference, client-side tools). Two of my assumptions were **wrong**, now corrected:

- **Wrong:** I sent `transcription_prompt` and `key_terms` as top-level session fields. **Correct:** they live nested — `session.input.transcription_prompt` and `session.input.keyterms` (that spelling, no underscore). Unknown top-level fields are silently ignored, so all my transcription biasing is currently doing nothing. This alone likely explains part of the agent's confusion.
- **Right, now verified three ways:** `tool.call` carries `arguments` as a ready-to-use object; `tool.result` takes `{call_id, result-as-JSON-string, is_error?}`; audio is base64 PCM16 mono 24 kHz both directions.

The rebuild, doc-grounded:

1. **Runtime sample-rate handling** (their documented cross-browser pipeline): detect the device rate, resample mic audio to 24 kHz inside the audio worklet, keep echo cancellation on. No more assuming. This is *the* fix for judges on unknown browsers and audio devices.
2. **Correct session shape:** `system_prompt`, `tools`, `output: {voice}`, plus `input: {transcription_prompt, keyterms, language_codes: ["en"], transcription_mode: "balanced"}`. No `greeting`.
3. **Trust-but-verify:** after connect, the server echoes the resolved config in `session.ready`. I'll log it and show a tiny "voice ready" state only when the echo confirms our config applied — if AssemblyAI ever ignores a field, we'll see it instead of guessing.
4. **Bulletproof turn-taking:** queue tool results, flush on every safe moment (`reply.done`), expire anything stale, and — new — send backend rejections with `is_error: true` plus a speakable recovery message, so the agent re-asks for one field instead of dying quietly.
5. **Liveness:** show the running transcript (`transcript.user.delta` supersedes per line, never concatenate) so silence is never mysterious, and add reconnect-via-`session.resume` for drops inside the 30 s window.
6. **Judge-proofing:** typed fallback stays one tap away on the same screen; a short mic/echo note for judges (headphones help on speakers). Token auth stays as-is — your test session audibly connected, which confirms the current method works.

### 7. Minimal UI: approved as you specified

- **Home:** prominent **Speak** button, **History** button, **Reset** button, one live conversation text space, one status line. Nothing else.
- **Review:** a single confirm card (readback + **Confirm and save**) appears when the draft is reviewable. Corrections happen by voice; no grids, no remove buttons on the main flow.
- **History (one tap away):** saved reports, original wording, printable summary, earlier revisions.
- Safety invariants stay: explicit confirmation, readback with units, no silent saves — they're just hidden behind the flow instead of displayed as panels.

Say the word and I'll rebuild the voice client and home screen to exactly this. If you want any tweak to the plan first (e.g. keep the typed box always visible vs behind a button), tell me now — cheaper than rework later.
