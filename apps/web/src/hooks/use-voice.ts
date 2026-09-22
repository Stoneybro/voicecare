// Browser voice session for the AssemblyAI Voice Agent API (client component).
//
// Flow: fetch a single-use token plus the server-built session config from
// POST /api/voice/token, open wss://agents.assemblyai.com/v1/ws?token=..., send one
// session.update with the inline configuration (no greeting — the session opens silently),
// stream microphone PCM16 resampled to 24 kHz, play back reply.audio, and forward tool.call
// frames to POST /api/drafts/:id/tool.
//
// Audio runs at the device's own rate: the worklet resamples to 24 kHz in code, so capture
// and echo cancellation work on every browser instead of assuming 24 kHz (which garbles
// audio wherever the browser ignores the request).
//
// Tool results are flushed only when reply.done is the latest event (interactive execution
// mode); an interrupted turn drops its pending results, stale ones expire, and backend
// rejections go back with is_error so the agent re-asks for one field instead of stalling.
// A dropped socket resumes once via session.resume inside the 30 s grace window.
// Sessions end cleanly with session.end so the resume window is not billed.
//
// Turn control is manual from the caregiver's point of view: Speak opens the mic, Done
// stops audio leaving the browser (the session stays open), and the server finalizes the
// turn on silence. There is no commit-turn event in the API, so Done is a mic gate plus a
// reply.create watchdog fallback — both documented primitives. Cancel ends the session and
// leaves the draft untouched; nothing is ever saved without the confirm button.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceStatus =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "ready"
  | "listening"
  | "processing"
  | "error";

export type VoiceTranscriptLine = { speaker: "you" | "agent"; text: string };

type TurnDetection = { min_silence: number; max_silence: number; interrupt_response: boolean };

type SessionConfig = {
  system_prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[];
  output: { voice: string; format?: { encoding: string } };
  input?: {
    transcription_prompt?: string;
    keyterms?: string[];
    language_codes?: string[];
    transcription_mode?: string;
  };
};

type TokenResponse = {
  token?: string;
  session?: SessionConfig;
  turn?: { recording: TurnDetection; closing: TurnDetection };
  error?: { message?: string };
};



type PendingTool = { call_id: string; result: unknown; is_error: boolean; at: number };

function trace(...args: unknown[]): void {
  // Visible in DevTools (page context, not extensions). Keep the volume low: one line
  // per session event, so a stuck conversation shows exactly where it stopped.
  console.debug("[voicecare:voice]", ...args);
}

// Results older than this are never sent: the turn they belonged to is long gone.
const PENDING_TOOL_TTL_MS = 90_000;
const TARGET_SAMPLE_RATE = 24000;
// After Done, silence closes the turn by itself. Only if nothing happens within this long
// do we nudge the agent with reply.create — a fallback, never the primary path.
const DONE_WATCHDOG_MS = 6_000;

const DONE_NUDGE =
  "The caregiver tapped 'Done speaking'. Everything they said is final. Call update_draft " +
  "with the complete note if you have not yet, then either read the readback (finish_draft) " +
  "when complete or ask the first blocking question. One short question at a time.";

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalizeArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Fall through to empty; the backend returns a field-level error the agent can recover from.
    }
  }
  return {};
}

type BackendToolResponse = {
  error?: { code?: string; message?: string };
  draft?: { revision?: number } | null;
} & Record<string, unknown>;

export function useVoiceSession(options: {
  patientId: string | null;
  getDraft: () => { id: string; revision: number } | null;
  onDraftChanged: () => void;
}) {
  const { patientId, onDraftChanged } = options;
  const getDraftRef = useRef(options.getDraft);
  const onDraftChangedRef = useRef(onDraftChanged);
  useEffect(() => {
    getDraftRef.current = options.getDraft;
    onDraftChangedRef.current = onDraftChanged;
  });

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<VoiceTranscriptLine[]>([]);
  const [liveUser, setLiveUser] = useState<string | null>(null);
  const [liveAgent, setLiveAgent] = useState<string | null>(null);
  // True once session.ready echoes our transcription config back. If the API ever stops
  // applying a field, this goes false instead of failing silently.
  const [verified, setVerified] = useState(false);
  // True after Done until the caregiver answers again, a new note starts, or the session
  // ends. While done, the mic is gated (session stays open) and the UI offers answering.
  const [done, setDone] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackAtRef = useRef(0);
  const lastEventRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingTool[]>([]);
  const readyRef = useRef(false);
  const stoppedRef = useRef(false);
  const endedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const resumeAttemptedRef = useRef(false);
  const liveUserIdRef = useRef<string | null>(null);
  const liveUserTextRef = useRef<string | null>(null);
  const liveAgentIdRef = useRef<string | null>(null);
  const audioChunksRef = useRef(0);
  // Mic gate: Done stops audio leaving the browser without closing tracks or session.
  const sendingRef = useRef(false);
  // Turn postures from the token response (single source: lib/voice.ts). Only the
  // turn_detection field is ever sent mid-session, so immutable siblings stay untouched.
  const turnRef = useRef<TokenResponse["turn"]>(null);

  const retune = useCallback((which: "recording" | "closing") => {
    const ws = wsRef.current;
    const turn = which === "recording" ? turnRef.current?.recording : turnRef.current?.closing;
    if (!turn || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "session.update", session: { input: { turn_detection: turn } } }));
    trace("turn_detection posture:", which, `min=${turn.min_silence} max=${turn.max_silence}`);
  }, []);
  // Last sign of life after Done (transcript/tool/reply) and pending watchdog timers.
  const doneActivityRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const cleanup = useCallback(() => {
    stoppedRef.current = true;
    try {
      wsRef.current?.close();
    } catch {
      // Socket already gone; nothing to close.
    }
    wsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    readyRef.current = false;
    pendingRef.current = [];
    lastEventRef.current = null;
    liveUserIdRef.current = null;
    liveUserTextRef.current = null;
    liveAgentIdRef.current = null;
    sendingRef.current = false;
    for (const timer of watchdogRef.current) clearTimeout(timer);
    watchdogRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);
  useEffect(() => {
    const onPageHide = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "session.end" }));
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const flushTools = useCallback(() => {
    const ws = wsRef.current;
    if (lastEventRef.current !== "reply.done" || pendingRef.current.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const before = pendingRef.current.length;
    pendingRef.current = pendingRef.current.filter((tool) => now - tool.at < PENDING_TOOL_TTL_MS);
    if (pendingRef.current.length !== before) trace("dropped stale tool results:", before - pendingRef.current.length);
    trace("flushing tool results:", pendingRef.current.length);
    for (const tool of pendingRef.current) {
      ws.send(
        JSON.stringify({
          type: "tool.result",
          call_id: tool.call_id,
          result: JSON.stringify(tool.result),
          ...(tool.is_error ? { is_error: true } : {}),
        }),
      );
    }
    pendingRef.current = [];
  }, []);

  const postTool = useCallback(async (draftId: string, name: string, args: Record<string, unknown>, revision: number) => {
    const response = await fetch(`/api/drafts/${draftId}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args, expected_revision: revision }),
    });
    const payload = (await response.json()) as BackendToolResponse;
    trace(`tool ${name} -> HTTP ${response.status}`, payload.error ? `${payload.error.code}: ${payload.error.message}` : "ok");
    return payload;
  }, []);

  const runToolCall = useCallback(
    async (name: string, args: Record<string, unknown>, callId: string) => {
      const draft = getDraftRef.current();
      if (!draft) {
        pendingRef.current.push({
          call_id: callId,
          result: { error: "no_draft: No draft is open. Ask the caregiver to start a report first." },
          is_error: true,
          at: Date.now(),
        });
        flushTools();
        return;
      }
      try {
        let payload = await postTool(draft.id, name, { ...args, expected_revision: draft.revision }, draft.revision);
        // One automatic retry: the draft moved between the agent's turn and our POST.
        // The rejection carries the latest draft, so retry once at the fresh revision.
        if (payload.error?.code === "stale_revision" && payload.draft?.revision) {
          payload = await postTool(draft.id, name, { ...args, expected_revision: payload.draft.revision }, payload.draft.revision);
        }
        if (payload.error) {
          trace("tool result is_error:", payload.error.code, payload.error.message);
          pendingRef.current.push({
            call_id: callId,
            result: {
              error: `${payload.error.code ?? "update_failed"}: ${payload.error.message ?? "The update failed. Ask the caregiver to repeat that."}`,
              ...(payload.draft?.revision ? { latest_revision: payload.draft.revision } : {}),
            },
            is_error: true,
            at: Date.now(),
          });
        } else {
          trace("tool result ok, revision:", (payload as { revision?: number }).revision);
          pendingRef.current.push({ call_id: callId, result: payload, is_error: false, at: Date.now() });
        }
      } catch {
        pendingRef.current.push({
          call_id: callId,
          result: { error: "update_failed: The update failed. Ask the caregiver to repeat that." },
          is_error: true,
          at: Date.now(),
        });
      }
      onDraftChangedRef.current();
      flushTools();
    },
    [flushTools, postTool],
  );

  const handleMessage = useCallback(
    (msg: { type?: string } & Record<string, unknown>) => {
      if (stoppedRef.current) return;
      const type = msg.type;

      if (type === "session.ready") {
        readyRef.current = true;
        if (typeof msg.session_id === "string") sessionIdRef.current = msg.session_id;
        // Trust but verify: only consider the session fully working when the echoed
        // config shows our transcription biasing actually applied.
        const config = msg.config as { input?: { transcription_prompt?: string } } | undefined;
        const ok = Boolean(config?.input?.transcription_prompt);
        trace("session.ready, transcription config applied:", ok);
        setVerified(ok);
        setStatus("ready");
      } else if (type === "session.updated") {
        // Config acknowledgement; nothing to do.
      } else if (type === "input.speech.started") {
        lastEventRef.current = type;
        trace("user started speaking");
        setStatus("listening");
      } else if (type === "input.speech.stopped") {
        trace("user stopped speaking, waiting for reply");
        setStatus("processing");
      } else if (type === "reply.started") {
        lastEventRef.current = type;
        audioChunksRef.current = 0;
        doneActivityRef.current = Date.now();
        setStatus("processing");
      } else if (type === "reply.audio" && typeof msg.data === "string") {
        audioChunksRef.current += 1;
        if (audioChunksRef.current === 1) trace("first reply.audio chunk, bytes:", (msg.data as string).length);
        const raw = atob(msg.data);
        const pcm16 = new Int16Array(raw.length / 2);
        for (let i = 0; i < pcm16.length; i++) {
          pcm16[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
        }
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) float32[i] = (pcm16[i] ?? 0) / 32768;
        const ctx = audioCtxRef.current;
        if (ctx) {
          // The context resamples to the device rate on output, so this plays correctly
          // on every browser even though the chunks are 24 kHz.
          const buffer = ctx.createBuffer(1, float32.length, TARGET_SAMPLE_RATE);
          buffer.getChannelData(0).set(float32);
          const srcNode = ctx.createBufferSource();
          srcNode.buffer = buffer;
          srcNode.connect(ctx.destination);
          playbackAtRef.current = Math.max(playbackAtRef.current, ctx.currentTime);
          srcNode.start(playbackAtRef.current);
          playbackAtRef.current += buffer.duration;
        }
      } else if (type === "reply.done") {
        lastEventRef.current = type;
        trace("reply.done, status:", msg.status, "pending tools:", pendingRef.current.length);
        if (msg.status === "interrupted") {
          pendingRef.current = [];
          setLiveAgent(null);
          liveAgentIdRef.current = null;
          const ctx = audioCtxRef.current;
          if (ctx) playbackAtRef.current = ctx.currentTime;
        } else {
          flushTools();
        }
        if (readyRef.current) setStatus("ready");
      } else if (type === "transcript.user.delta" && typeof msg.text === "string") {
        const itemId = typeof msg.item_id === "string" ? msg.item_id : null;
        // Delta text is the full transcript so far for this item: replace, never append.
        // A new item commits the previous partial line so nothing is lost.
        if (itemId !== null && itemId !== liveUserIdRef.current && liveUserTextRef.current) {
          const committed = liveUserTextRef.current;
          setLines((prev) => [...prev, { speaker: "you", text: committed }]);
        }
        liveUserIdRef.current = itemId;
        liveUserTextRef.current = msg.text;
        setLiveUser(msg.text);
        setStatus("listening");
      } else if (type === "transcript.user" && typeof msg.text === "string") {
        doneActivityRef.current = Date.now();
        setLines((prev) => [...prev, { speaker: "you", text: msg.text as string }]);
        setLiveUser(null);
        liveUserIdRef.current = null;
        liveUserTextRef.current = null;
        setStatus("processing");
      } else if (type === "transcript.agent.delta" && typeof msg.delta === "string") {
        const replyId = typeof msg.reply_id === "string" ? msg.reply_id : null;
        if (liveAgentIdRef.current !== null && replyId !== null && replyId !== liveAgentIdRef.current) {
          setLiveAgent(msg.delta);
        } else {
          // Word-level deltas are incremental tokens: accumulate within one reply.
          setLiveAgent((prev) => (prev ? `${prev} ${msg.delta as string}` : (msg.delta as string)));
        }
        liveAgentIdRef.current = replyId;
      } else if (type === "transcript.agent" && typeof msg.text === "string") {
        setLines((prev) => [...prev, { speaker: "agent", text: msg.text as string }]);
        setLiveAgent(null);
        liveAgentIdRef.current = null;
      } else if (type === "tool.call" && typeof msg.name === "string" && typeof msg.call_id === "string") {
        trace("tool.call:", msg.name);
        doneActivityRef.current = Date.now();
        void runToolCall(msg.name, normalizeArguments(msg.arguments), msg.call_id);
      } else if ((type === "session.error" || type === "error") && !stoppedRef.current) {
        const message = typeof msg.message === "string" ? msg.message : "The voice session reported an error.";
        setError(`${message} You can keep going with typed observations.`);
        setStatus("error");
      } else if (type === "session.ended") {
        endedRef.current = true;
        cleanup();
        setStatus("idle");
      }
    },
    [cleanup, flushTools, runToolCall],
  );

  const openSocketRef = useRef<(mode: "fresh" | "resume", sessionConfig: SessionConfig | null, token: string) => Promise<void>>(
    async () => undefined,
  );
  const openSocket = useCallback(
    async (mode: "fresh" | "resume", sessionConfig: SessionConfig | null, token: string) => {
      const wsUrl = new URL("wss://agents.assemblyai.com/v1/ws");
      wsUrl.searchParams.set("token", token);
      const ws = new WebSocket(wsUrl.toString());
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (mode === "resume" && sessionIdRef.current) {
          ws.send(JSON.stringify({ type: "session.resume", session_id: sessionIdRef.current }));
        } else if (sessionConfig) {
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                system_prompt: sessionConfig.system_prompt,
                tools: sessionConfig.tools,
                output: sessionConfig.output,
                ...(sessionConfig.input ? { input: sessionConfig.input } : {}),
              },
            }),
          );
        }
      });

      ws.addEventListener("message", (event) => {
        let msg: { type?: string } & Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string) as typeof msg;
        } catch {
          return;
        }
        if (mode === "resume" && (msg.type === "session.error" || msg.type === "error")) {
          // Resume failed (expired or forbidden): fall back to a fresh session on next tap.
          setError("The connection dropped and could not resume. Tap Speak to start a new session.");
          setStatus("error");
          cleanup();
          return;
        }
        handleMessage(msg);
      });

      ws.addEventListener("close", () => {
        if (stoppedRef.current || endedRef.current) return;
        readyRef.current = false;
        if (!sessionIdRef.current) {
          // Never became ready, so no resume is possible: don't leave a dead mic behind.
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        // Unexpected drop inside the 30 s grace window: resume once with a fresh token.
        if (sessionIdRef.current && !resumeAttemptedRef.current) {
          resumeAttemptedRef.current = true;
          setStatus("connecting");
          void (async () => {
            try {
              const response = await fetch(`/api/voice/token?patient_id=${encodeURIComponent(patientId ?? "")}`, { method: "POST" });
              const payload = (await response.json()) as { token?: string };
              if (!response.ok || !payload.token || stoppedRef.current) throw new Error("resume failed");
              await openSocketRef.current("resume", null, payload.token);
            } catch {
              setError("The connection dropped. Tap Speak to start a new session, or type your observation.");
              setStatus("error");
              cleanup();
            }
          })();
        } else {
          setStatus((current) => (current === "error" ? current : "idle"));
        }
      });
    },
    [cleanup, handleMessage, patientId],
  );

  useEffect(() => {
    openSocketRef.current = openSocket;
  });

  const start = useCallback(async () => {
    if (!patientId) {
      setError("The demo session is still loading. Wait for it to be ready, then speak.");
      setStatus("error");
      return;
    }
    // A fresh tap must never orphan the previous audio graph: a live mic plus its worklet
    // would keep posting into the new socket, doubling the audio the server hears (garbled
    // input the transcription then fails on). Tear everything down first.
    cleanup();
    stoppedRef.current = false;
    endedRef.current = false;
    resumeAttemptedRef.current = false;
    sessionIdRef.current = null;
    setError(null);
    setDone(false);
    sendingRef.current = false;
    for (const timer of watchdogRef.current) clearTimeout(timer);
    watchdogRef.current = [];
    setLines([]);
    setLiveUser(null);
    liveUserTextRef.current = null;
    liveUserIdRef.current = null;
    setLiveAgent(null);
    liveAgentIdRef.current = null;
    setVerified(false);
    setStatus("requesting-mic");

    let stream: MediaStream;
    try {
      // Echo cancellation on (the agent must not hear itself); noise suppression off
      // (the server already denoises, and stacking a second layer hurts transcription).
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false },
      });
    } catch {
      setError("Microphone access was denied or is unavailable. Type your observation instead — it follows the same flow.");
      setStatus("error");
      return;
    }
    streamRef.current = stream;

    setStatus("connecting");
    let token: string;
    let sessionConfig: SessionConfig;
    try {
      const response = await fetch(`/api/voice/token?patient_id=${encodeURIComponent(patientId)}`, { method: "POST" });
      const payload = (await response.json()) as TokenResponse;
      if (!response.ok || !payload.token || !payload.session) {
        throw new Error(payload.error?.message ?? "The voice service could not start a session.");
      }
      token = payload.token;
      sessionConfig = payload.session;
      turnRef.current = payload.turn ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The voice service could not start a session.");
      setStatus("error");
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      return;
    }

    let audioCtx: AudioContext;
    try {
      // Device rate on purpose: the worklet resamples to 24 kHz, and only the default
      // audio graph feeds every browser's echo canceller.
      audioCtx = new AudioContext();
      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule("/pcm-processor.js");
    } catch {
      setError("Audio could not start in this browser. Type your observation instead.");
      setStatus("error");
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      return;
    }
    audioCtxRef.current = audioCtx;
    playbackAtRef.current = audioCtx.currentTime;

    const source = audioCtx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(audioCtx, "pcm-processor", {
      processorOptions: { inputSampleRate: audioCtx.sampleRate, targetSampleRate: TARGET_SAMPLE_RATE },
    });
    source.connect(worklet);
    // Deliberately not connected to the destination: the microphone must not play back locally.

    let audioTraced = false;
    worklet.port.onmessage = (event: MessageEvent) => {
      const ws = wsRef.current;
      // The mic gate: after Done, audio stays in the browser until the caregiver answers.
      if (sendingRef.current && readyRef.current && ws && ws.readyState === WebSocket.OPEN) {
        if (!audioTraced) {
          audioTraced = true;
          trace("mic flowing: first audio chunk sent");
        }
        ws.send(JSON.stringify({ type: "input.audio", audio: base64FromBytes(new Uint8Array(event.data as ArrayBuffer)) }));
      }
    };
    sendingRef.current = true;

    await openSocket("fresh", sessionConfig, token);
  }, [patientId, openSocket, cleanup]);

  const armWatchdog = useCallback(() => {
    for (const timer of watchdogRef.current) clearTimeout(timer);
    watchdogRef.current = [];
    doneActivityRef.current = Date.now();
    watchdogRef.current.push(
      setTimeout(() => {
        const ws = wsRef.current;
        if (stoppedRef.current || doneActivityRef.current > Date.now() - DONE_WATCHDOG_MS) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // Fallback only: silence normally closes the turn by itself. If nothing happened,
        // ask once for the reply explicitly instead of leaving the caregiver waiting.
        trace("watchdog: no turn activity after Done, sending reply.create");
        ws.send(JSON.stringify({ type: "reply.create", instructions: DONE_NUDGE }));
        watchdogRef.current.push(
          setTimeout(() => {
            if (!stoppedRef.current && doneActivityRef.current <= Date.now() - DONE_WATCHDOG_MS * 2) {
              setError("The assistant went quiet. Tap Cancel and speak again, or type your observation.");
              setStatus("error");
            }
          }, DONE_WATCHDOG_MS),
        );
      }, DONE_WATCHDOG_MS),
    );
  }, []);

  // Done Speaking: stop audio leaving the browser; the session, mic, and draft stay open.
  // Tighten the turn window at the same time so the finished turn closes within ~1 s
  // instead of waiting out the long recording window.
  const finishSpeaking = useCallback(() => {
    if (!readyRef.current || stoppedRef.current) return;
    sendingRef.current = false;
    setDone(true);
    setLiveUser(null);
    setStatus("processing");
    trace("done speaking: mic gated, waiting for turn to close");
    retune("closing");
    armWatchdog();
  }, [armWatchdog, retune]);

  // Answer: re-open the mic gate and restore the patient window, so a follow-up answer
  // streams on the same session and pauses are tolerated again.
  const resumeSpeaking = useCallback(() => {
    if (!readyRef.current || stoppedRef.current) return;
    for (const timer of watchdogRef.current) clearTimeout(timer);
    watchdogRef.current = [];
    sendingRef.current = true;
    setDone(false);
    setError(null);
    setStatus("listening");
    trace("answering: mic gate open");
    retune("recording");
  }, [retune]);

  // Cancel: end the session, leave the draft exactly as it is. Nothing is saved by this —
  // saving still requires the confirm button, so cancelling can never lose a saved report.
  const cancelSpeaking = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "session.end" }));
    }
    setDone(false);
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  const stop = cancelSpeaking;

  return {
    status,
    error,
    lines,
    liveUser,
    liveAgent,
    verified,
    done,
    start,
    stop,
    finishSpeaking,
    resumeSpeaking,
    cancelSpeaking,
    connected: status !== "idle" && status !== "error",
  };
}
