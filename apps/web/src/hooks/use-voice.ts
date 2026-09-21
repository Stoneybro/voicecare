// Browser voice session for the AssemblyAI Voice Agent API (client component).
//
// Flow: fetch a single-use token plus the server-built session config from
// POST /api/voice/token, open wss://agents.assemblyai.com/v1/ws?token=..., send one
// session.update with the inline configuration, stream microphone PCM16, play back
// reply.audio, and forward tool.call frames to POST /api/drafts/:id/tool.
//
// Tool results are flushed only when reply.done is the latest event (interactive
// execution mode); an interrupted turn drops its pending results. Sessions end cleanly
// with session.end so the 30-second resume window is not billed.

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

type SessionConfig = {
  system_prompt: string;
  greeting: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[];
  input: {
    format: { encoding: "audio/pcm" };
    keyterms: string[];
    transcription_mode: "balanced";
    transcription_prompt: string;
    language_codes: ["en"];
    turn_detection: {
      min_silence: number;
      max_silence: number;
      interrupt_response: true;
    };
  };
  output: { voice: string; format: { encoding: "audio/pcm" } };
};

type PendingTool = { call_id: string; result: unknown };

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

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackAtRef = useRef(0);
  const lastEventRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingTool[]>([]);
  const readyRef = useRef(false);
  const stoppedRef = useRef(false);

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
    for (const tool of pendingRef.current) {
      ws.send(JSON.stringify({ type: "tool.result", call_id: tool.call_id, result: JSON.stringify(tool.result) }));
    }
    pendingRef.current = [];
  }, []);

  const runToolCall = useCallback(
    async (name: string, args: Record<string, unknown>, callId: string) => {
      const draft = getDraftRef.current();
      if (!draft) {
        pendingRef.current.push({ call_id: callId, result: { error: "No draft is open. Ask the caregiver to start a report first." } });
        flushTools();
        return;
      }
      const argsWithRevision = { ...args, expected_revision: draft.revision };
      try {
        const response = await fetch(`/api/drafts/${draft.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, arguments: argsWithRevision, expected_revision: draft.revision }),
        });
        const payload = (await response.json()) as unknown;
        pendingRef.current.push({ call_id: callId, result: payload });
      } catch {
        pendingRef.current.push({ call_id: callId, result: { error: "The update failed. Ask the caregiver to repeat that." } });
      }
      onDraftChangedRef.current();
      flushTools();
    },
    [flushTools],
  );

  const start = useCallback(async () => {
    if (!patientId) {
      setError("The demo session is still loading. Wait for it to be ready, then speak.");
      setStatus("error");
      return;
    }
    stoppedRef.current = false;
    setError(null);
    setLines([]);
    setStatus("requesting-mic");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
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
      const payload = (await response.json()) as { token?: string; session?: SessionConfig; error?: { message?: string } };
      if (!response.ok || !payload.token || !payload.session) {
        throw new Error(payload.error?.message ?? "The voice service could not start a session.");
      }
      token = payload.token;
      sessionConfig = payload.session;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The voice service could not start a session.");
      setStatus("error");
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      return;
    }

    let audioCtx: AudioContext;
    try {
      audioCtx = new AudioContext({ sampleRate: 24000 });
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
    const worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
    source.connect(worklet);
    // Deliberately not connected to the destination: the microphone must not play back locally.

    const wsUrl = new URL("wss://agents.assemblyai.com/v1/ws");
    wsUrl.searchParams.set("token", token);
    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;

    worklet.port.onmessage = (event: MessageEvent) => {
      if (readyRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input.audio", audio: base64FromBytes(new Uint8Array(event.data as ArrayBuffer)) }));
      }
    };

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: sessionConfig,
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      let msg: { type?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as typeof msg;
      } catch {
        return;
      }
      if (stoppedRef.current) return;
      const type = msg.type;

      if (type === "session.ready") {
        readyRef.current = true;
        setStatus("ready");
      } else if (type === "input.speech.started") {
        lastEventRef.current = type;
        setStatus("listening");
      } else if (type === "reply.started") {
        lastEventRef.current = type;
        setStatus("processing");
      } else if (type === "reply.audio" && typeof msg.data === "string") {
        const raw = atob(msg.data);
        const pcm16 = new Int16Array(raw.length / 2);
        for (let i = 0; i < pcm16.length; i++) {
          pcm16[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
        }
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) float32[i] = (pcm16[i] ?? 0) / 32768;
        const ctx = audioCtxRef.current;
        if (ctx) {
          const buffer = ctx.createBuffer(1, float32.length, 24000);
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
        if (msg.status === "interrupted") {
          pendingRef.current = [];
          const ctx = audioCtxRef.current;
          if (ctx) playbackAtRef.current = ctx.currentTime;
        } else {
          flushTools();
        }
        if (readyRef.current) setStatus("ready");
      } else if (type === "transcript.user" && typeof msg.text === "string") {
        setLines((prev) => [...prev, { speaker: "you", text: msg.text as string }]);
        setStatus("processing");
      } else if (type === "transcript.agent" && typeof msg.text === "string") {
        setLines((prev) => [...prev, { speaker: "agent", text: msg.text as string }]);
      } else if (type === "tool.call" && typeof msg.name === "string" && typeof msg.call_id === "string") {
        void runToolCall(msg.name, normalizeArguments(msg.arguments), msg.call_id);
      } else if ((type === "session.error" || type === "error") && !stoppedRef.current) {
        const message = typeof msg.message === "string" ? msg.message : "The voice session reported an error.";
        setError(`${message} You can keep going with typed observations.`);
        setStatus("error");
      } else if (type === "session.ended") {
        cleanup();
        setStatus("idle");
      }
    });

    ws.addEventListener("close", () => {
      if (!stoppedRef.current) {
        readyRef.current = false;
        setStatus((current) => (current === "error" ? current : "idle"));
      }
    });
  }, [patientId, cleanup, flushTools, runToolCall]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "session.end" }));
    }
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  return { status, error, lines, start, stop, connected: status !== "idle" && status !== "error" };
}
