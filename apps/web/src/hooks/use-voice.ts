// Browser voice session: two stages.
//
//   Stage 1 — Voice note with live medical transcription (no turn-by-turn chat):
//     mic -> MediaRecorder (backup blob) + AudioWorklet resample to 16 kHz PCM16
//     -> AssemblyAI Streaming STT (domain medical-v1) over its own WebSocket.
//     The caregiver sees live captions and speaks freely with pauses. Tapping
//     Done sends Terminate, collects the finalized turns, and closes Stage 1.
//     If streaming fails or hears nothing, the backup blob is transcribed via
//     POST /api/voice/transcribe (async STT, also medical-v1).
//   Stage 2 — Clarification with the Voice Agent API (turn-based conversation):
//     the Stage 1 transcript is injected via conversation.message + reply.create
//     into a Voice Agent WebSocket, which runs its normal tool-calling loop
//     (update_draft, finish_draft, ask_caregiver).
//
// Follow-up answers reuse Stage 1 (record -> live transcribe -> inject) on the
// already-open Stage 2 session, so conversation context is preserved.
//
// Tool results are flushed only when reply.done is the latest event; an interrupted turn
// drops pending results. Sessions end cleanly with session.end.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceStatus =
  | "idle"
  | "requesting-mic"
  | "recording"      // MediaRecorder running locally — no streaming
  | "transcribing"   // uploaded to STT API, waiting for transcript
  | "connecting"     // opening voice agent WebSocket with transcript
  | "ready"
  | "listening"      // caregiver recording a follow-up answer
  | "processing"
  | "error";

export type VoiceTranscriptLine = { speaker: "you" | "agent"; text: string };

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
// Safety net: if reply.create after transcript injection gets no response in this long, warn.
const DONE_WATCHDOG_MS = 12_000;

const DONE_NUDGE =
  "The caregiver has finished speaking and is waiting. " +
  "Call update_draft with everything you heard, then call finish_draft or ask one short blocking question.";

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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Stage 1 live medical transcription (separate from the Stage 2 agent socket).
  const streamWsRef = useRef<WebSocket | null>(null);
  const streamFinalsRef = useRef<string[]>([]);
  const streamNodesRef = useRef<{ source: MediaStreamAudioSourceNode; worklet: AudioWorkletNode; gain: GainNode } | null>(null);
  const streamLiveRef = useRef<string | null>(null);
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

  // Last sign of life after Done (transcript/tool/reply) and pending watchdog timers.
  const doneActivityRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Forward ref so start() (declared below) can kick off live streaming without a
  // use-before-declaration cycle: assigned once startStreaming is defined.
  const startStreamingRef = useRef<() => Promise<void>>(async () => undefined);

  const cleanup = useCallback(() => {
    stoppedRef.current = true;
    // Stop any in-progress recording.
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    try {
      wsRef.current?.close();
    } catch {
      // Socket already gone; nothing to close.
    }
    wsRef.current = null;
    try {
      streamWsRef.current?.close();
    } catch {
      // Streaming socket already gone.
    }
    streamWsRef.current = null;
    streamFinalsRef.current = [];
    streamLiveRef.current = null;
    if (streamNodesRef.current) {
      try {
        streamNodesRef.current.worklet.disconnect();
        streamNodesRef.current.source.disconnect();
        streamNodesRef.current.gain.disconnect();
      } catch {
        // Nodes already torn down.
      }
      streamNodesRef.current = null;
    }
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
        trace("session.ready");
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


  // Helper: get the best supported MediaRecorder MIME type.
  function getBestMimeType(): string {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", ""];
    return candidates.find((type) => !type || MediaRecorder.isTypeSupported(type)) ?? "";
  }

  // Phase 1 of the push-to-talk flow: get the mic, start a local MediaRecorder
  // (backup blob) and live medical streaming (captions) together.
  const start = useCallback(async () => {
    if (!patientId) {
      setError("The demo session is still loading. Wait for it to be ready, then speak.");
      setStatus("error");
      return;
    }
    cleanup();
    stoppedRef.current = false;
    endedRef.current = false;
    resumeAttemptedRef.current = false;
    sessionIdRef.current = null;
    chunksRef.current = [];
    setError(null);
    setDone(false);
    setLines([]);
    setLiveUser(null);
    liveUserTextRef.current = null;
    liveUserIdRef.current = null;
    setLiveAgent(null);
    liveAgentIdRef.current = null;
    setStatus("requesting-mic");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setError("Microphone access was denied or is unavailable. Type your observation instead.");
      setStatus("error");
      return;
    }
    streamRef.current = stream;

    // Create an AudioContext now so playback is ready when the agent responds later.
    try {
      const audioCtx = new AudioContext();
      await audioCtx.resume();
      audioCtxRef.current = audioCtx;
      playbackAtRef.current = audioCtx.currentTime;
    } catch {
      // Playback audio won't work but recording still can; don't block the flow.
      trace("AudioContext failed to start — agent audio will be silent");
    }

    const mimeType = getBestMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.start(500); // collect chunks every 500 ms so we don't lose data on stop
    setStatus("recording");
    trace("MediaRecorder started, mimeType:", recorder.mimeType);
    // Live medical captions start alongside the backup recording. Failures fall
    // back to the backup blob silently.
    streamFinalsRef.current = [];
    void startStreamingRef.current();
  }, [patientId, cleanup]);

  // Helper: stop the recorder and return the complete audio Blob.
  const stopRecorder = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        resolve(new Blob(chunksRef.current));
        return;
      }
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        resolve(new Blob(chunksRef.current, { type: mimeType }));
      };
      recorder.stop();
    });
  }, []);

  // Helper: POST audio blob to the STT endpoint and return the transcript.
  const transcribeBlob = useCallback(async (blob: Blob): Promise<string> => {
    const form = new FormData();
    form.append("audio", blob, "recording.webm");
    const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
    const payload = (await response.json()) as { text?: string; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(payload.error?.message ?? "Transcription failed.");
    }
    return payload.text ?? "";
  }, []);

  // Helper: fetch a token + session config for a fresh or resumed voice agent session.
  const fetchToken = useCallback(async (): Promise<{ token: string; session: SessionConfig }> => {
    const response = await fetch(`/api/voice/token?patient_id=${encodeURIComponent(patientId ?? "")}`, { method: "POST" });
    const payload = (await response.json()) as TokenResponse;
    if (!response.ok || !payload.token || !payload.session) {
      throw new Error(payload.error?.message ?? "The voice service could not start a session.");
    }
    return { token: payload.token, session: payload.session };
  }, [patientId]);

  // Stage 1: open live medical transcription (Streaming STT, domain medical-v1).
  // Runs alongside the MediaRecorder backup. Failures are silent by design: the
  // backup blob + async fallback still produce a transcript after Done.
  const startStreaming = useCallback(async () => {
    const ctx = audioCtxRef.current;
    const mic = streamRef.current;
    if (!ctx || !mic || stoppedRef.current) return;
    let token: string;
    let streaming: {
      sample_rate: number;
      speech_model: string;
      domain: string;
      min_turn_silence: number;
      max_turn_silence: number;
      keyterms_prompt: string[];
      prompt: string;
    };
    try {
      const response = await fetch(`/api/voice/streaming-token?patient_id=${encodeURIComponent(patientId ?? "")}`, { method: "POST" });
      const payload = (await response.json()) as { token?: string; streaming?: typeof streaming; error?: { message?: string } };
      if (!response.ok || !payload.token || !payload.streaming) throw new Error(payload.error?.message ?? "streaming unavailable");
      token = payload.token;
      streaming = payload.streaming;
    } catch (err) {
      trace("live transcription unavailable, backup recording continues:", err instanceof Error ? err.message : err);
      return;
    }
    try {
      await ctx.audioWorklet.addModule("/pcm-processor.js");
    } catch (err) {
      trace("audio worklet failed, backup recording continues:", err instanceof Error ? err.message : err);
      return;
    }
    if (stoppedRef.current) return;
    const params = new URLSearchParams({
      token,
      sample_rate: String(streaming.sample_rate ?? 16000),
      speech_model: streaming.speech_model ?? "universal-3-5-pro",
      domain: streaming.domain ?? "medical-v1",
      min_turn_silence: String(streaming.min_turn_silence ?? 800),
      max_turn_silence: String(streaming.max_turn_silence ?? 3600),
    });
    if (streaming.keyterms_prompt?.length) params.set("keyterms_prompt", JSON.stringify(streaming.keyterms_prompt));
    if (streaming.prompt) params.set("prompt", streaming.prompt);
    const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params.toString()}`);
    streamWsRef.current = ws;
    streamFinalsRef.current = [];
    streamLiveRef.current = null;

    ws.addEventListener("open", () => {
      if (stoppedRef.current || streamWsRef.current !== ws) return;
      trace("medical streaming open (medical-v1)");
      try {
        const source = ctx.createMediaStreamSource(mic);
        const worklet = new AudioWorkletNode(ctx, "pcm-processor", {
          processorOptions: { inputSampleRate: ctx.sampleRate, targetSampleRate: 16000 },
        });
        // Zero-gain sink: provably silent locally, provably pulled on every browser.
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(worklet);
        worklet.connect(gain);
        gain.connect(ctx.destination);
        worklet.port.onmessage = (event: MessageEvent) => {
          const socket = streamWsRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN || stoppedRef.current) return;
          const buffer = event.data as ArrayBuffer;
          if (buffer.byteLength === 0) return;
          socket.send(buffer);
        };
        streamNodesRef.current = { source, worklet, gain };
      } catch (err) {
        trace("streaming capture failed, backup continues:", err instanceof Error ? err.message : err);
      }
    });

    ws.addEventListener("message", (event) => {
      let msg: { type?: string; transcript?: string; end_of_turn?: boolean } & Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "Turn" && typeof msg.transcript === "string") {
        if (msg.end_of_turn) {
          const text = msg.transcript.trim();
          streamLiveRef.current = null;
          setLiveUser(null);
          if (text) {
            streamFinalsRef.current.push(text);
            // Commit each finalized turn so a long note stays visible live.
            setLines((prev) => [...prev, { speaker: "you", text }]);
          }
        } else {
          streamLiveRef.current = msg.transcript;
          setLiveUser(msg.transcript);
        }
      } else if (msg.type === "Termination") {
        trace("medical streaming terminated");
      }
    });

    ws.addEventListener("error", () => {
      trace("medical streaming error, backup recording continues");
    });
  }, [patientId]);

  // Stage 1 Done: terminate streaming, collect finalized turns (wait briefly for
  // the last final), tear down capture nodes. Returns "" when nothing was heard.
  const stopStreaming = useCallback(async (): Promise<string> => {
    const ws = streamWsRef.current;
    if (streamNodesRef.current) {
      try {
        streamNodesRef.current.worklet.disconnect();
        streamNodesRef.current.source.disconnect();
        streamNodesRef.current.gain.disconnect();
      } catch {
        // Already torn down.
      }
      streamNodesRef.current = null;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      streamWsRef.current = null;
      return streamFinalsRef.current.join(" ").trim();
    }
    const finalsBefore = streamFinalsRef.current.length;
    try {
      ws.send(JSON.stringify({ type: "Terminate" }));
    } catch {
      // Socket dying; fall through to collected finals.
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2500);
      const check = setInterval(() => {
        if (streamFinalsRef.current.length > finalsBefore || ws.readyState !== WebSocket.OPEN) {
          clearInterval(check);
          clearTimeout(timeout);
          // Give the final Turn message one beat to arrive after Terminate.
          setTimeout(resolve, 400);
        }
      }, 150);
    });
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    streamWsRef.current = null;
    setLiveUser(null);
    streamLiveRef.current = null;
    return streamFinalsRef.current.join(" ").trim();
  }, []);

  useEffect(() => {
    startStreamingRef.current = startStreaming;
  });

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

  // Stage 1 Done -> Stage 2: stop streaming + recorder, prefer the live medical
  // transcript, fall back to the backup blob, then inject into the voice agent.
  // This is called when the caregiver taps "Done Speaking" for the first time.
  const finishSpeaking = useCallback(async () => {
    if (stoppedRef.current) return;
    setDone(true);
    setStatus("transcribing");
    trace("done speaking: stopping live medical transcription + recorder");

    // Tear down live streaming first so its finals are complete before we read them.
    const streamed = await stopStreaming();
    let blob: Blob;
    try {
      blob = await stopRecorder();
    } catch {
      setError("Could not read the recording. Please try again.");
      setStatus("error");
      return;
    }

    let transcript = streamed;
    const streamedUsed = transcript.trim().length > 0;
    if (!streamedUsed) {
      if (blob.size === 0) {
        setError("The recording appears to be empty. Make sure your microphone is working and try again.");
        setStatus("error");
        return;
      }
      try {
        transcript = await transcribeBlob(blob);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Transcription failed. Please try again.");
        setStatus("error");
        return;
      }
    } else {
      trace("live medical transcript used, chars:", transcript.length);
    }

    if (!transcript.trim()) {
      setError("No speech was detected in the recording. Please speak clearly and try again.");
      setStatus("error");
      return;
    }

    trace("transcript received:", transcript.slice(0, 80));
    if (!streamedUsed) {
      // Fallback path only: live finals were already committed line-by-line during
      // recording, so committing again would duplicate the note.
      setLines((prev) => [...prev, { speaker: "you", text: transcript }]);
    }

    // Open the voice agent session (or reuse the existing one if it's still alive).
    setStatus("connecting");
    try {
      const ws = wsRef.current;
      const sessionAlive = ws && ws.readyState === WebSocket.OPEN && readyRef.current;
      if (!sessionAlive) {
        // No live session yet (first note, or session died): open a fresh one.
        stoppedRef.current = false;
        const { token, session } = await fetchToken();
        await openSocket("fresh", session, token);
        // Wait until session.ready fires (handleMessage sets readyRef and setStatus).
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (readyRef.current || stoppedRef.current) {
              clearInterval(interval);
              resolve();
            }
          }, 100);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The voice service could not start a session.");
      setStatus("error");
      return;
    }

    if (stoppedRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("The voice session dropped before the transcript could be sent. Please try again.");
      setStatus("error");
      return;
    }

    // Inject the transcript and ask the agent to respond.
    ws.send(JSON.stringify({ type: "conversation.message", role: "user", content: transcript }));
    ws.send(JSON.stringify({ type: "reply.create" }));
    setStatus("processing");
    trace("transcript injected, reply.create sent");
    armWatchdog();
  }, [armWatchdog, fetchToken, openSocket, stopRecorder, stopStreaming, transcribeBlob]);

  // Answer: re-record a follow-up answer on the same open voice agent session.
  // Same two-stage flow: live medical streaming + backup recording -> Done ->
  // inject -> reply.create. Tapping Done again runs finishSpeaking, which reuses
  // the open agent session.
  const resumeSpeaking = useCallback(async () => {
    if (stoppedRef.current) return;
    const stream = streamRef.current;
    if (!stream) {
      setError("Microphone is no longer available. Tap Cancel and start again.");
      setStatus("error");
      return;
    }
    chunksRef.current = [];
    streamFinalsRef.current = [];
    setDone(false);
    setError(null);

    // Reuse the same mic stream; just start a new recorder + live streaming.
    const mimeType = getBestMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start(500);
    setStatus("listening");
    trace("answering: recorder + live medical transcription restarted for follow-up");
    void startStreaming();
  }, [startStreaming]);

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
    done,
    start,
    stop,
    finishSpeaking,
    resumeSpeaking,
    cancelSpeaking,
    connected: status !== "idle" && status !== "error" && status !== "recording" && status !== "transcribing",
  };
}
