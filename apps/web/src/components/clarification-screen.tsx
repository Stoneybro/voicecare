"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle, Mic, MicOff } from "lucide-react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Props = { draftId: string; onBack: () => void; onReview: () => void };
type VoiceConfig = { system_prompt: string; greeting: string; input: object; output: object; tools: object[] };
type TokenPayload = { token: string; issue_id: string; question: string; session: VoiceConfig };
type ToolCall = { call_id: string; name: string; arguments: { answer?: string } };

function messageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object" &&
    "message" in payload.error && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function fromBase64(value: string): Float32Array {
  const binary = atob(value);
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    let sample = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    samples[index] = sample / 32768;
  }
  return samples;
}

function resampleTo24k(input: Float32Array, inputRate: number): ArrayBuffer {
  const ratio = inputRate / 24_000;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += input[sample];
    const value = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : input[start] ?? 0));
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output.buffer;
}

export function ClarificationScreen({ draftId, onBack, onReview }: Props) {
  const [state, setState] = useState<AgentState>(null);
  const [status, setStatus] = useState("Start when you're ready. VoiceCare will ask only about details that need clarification.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackTimeRef = useRef(0);
  const readyRef = useRef(false);
  const issueIdRef = useRef("");
  const pendingToolRef = useRef<ToolCall | null>(null);

  const cleanup = useCallback((endSession: boolean) => {
    readyRef.current = false;
    const socket = socketRef.current;
    if (endSession && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session.end" }));
    socketRef.current = null;
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access needs a secure browser connection.");
      const response = await fetch(`/api/agent-token?draft_id=${encodeURIComponent(draftId)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as TokenPayload | null;
      if (!response.ok || !payload?.token || !payload.session) throw new Error(messageFrom(payload, "Voice clarification could not start."));

      const audioContext = new AudioContext();
      contextRef.current = audioContext;
      await audioContext.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
      streamRef.current = stream;
      const socketUrl = new URL("wss://agents.assemblyai.com/v1/ws");
      socketUrl.searchParams.set("token", payload.token);
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;
      issueIdRef.current = payload.issue_id;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        if (!readyRef.current || socket.readyState !== WebSocket.OPEN) return;
        const pcm = resampleTo24k(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
        socket.send(JSON.stringify({ type: "input.audio", audio: toBase64(pcm) }));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "session.update", session: payload.session }));
        setStatus("Connecting to the voice assistant...");
        setState("thinking");
      };
      socket.onmessage = (event) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
        if (message.type === "session.ready") {
          readyRef.current = true;
          setState("listening");
          setStatus("Listening. Answer the question whenever you're ready.");
        } else if (message.type === "input.speech.started") {
          setState("listening");
        } else if (message.type === "reply.started") {
          setState("talking");
        } else if (message.type === "reply.audio" && typeof message.data === "string") {
          const samples = fromBase64(message.data);
          const buffer = audioContext.createBuffer(1, samples.length, 24_000);
          buffer.getChannelData(0).set(samples);
          const player = audioContext.createBufferSource();
          player.buffer = buffer;
          player.connect(audioContext.destination);
          playbackTimeRef.current = Math.max(audioContext.currentTime, playbackTimeRef.current);
          player.start(playbackTimeRef.current);
          playbackTimeRef.current += buffer.duration;
        } else if (message.type === "tool.call" && message.name === "submit_clarification_answer") {
          pendingToolRef.current = message as unknown as ToolCall;
          readyRef.current = false;
          setStatus("Saving your answer...");
          setState("thinking");
        } else if (message.type === "reply.done" && pendingToolRef.current) {
          const tool = pendingToolRef.current;
          pendingToolRef.current = null;
          void (async () => {
            try {
              const answer = typeof tool.arguments?.answer === "string" ? tool.arguments.answer : "";
              const saveResponse = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/clarify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ issue_id: issueIdRef.current, answer }),
              });
              const result = await saveResponse.json().catch(() => null);
              if (!saveResponse.ok) throw new Error(messageFrom(result, "That answer could not be saved."));
              const nextIssueId = typeof result.next_issue_id === "string" ? result.next_issue_id : null;
              if (nextIssueId) issueIdRef.current = nextIssueId;
              socket.send(JSON.stringify({
                type: "tool.result",
                call_id: tool.call_id,
                result: JSON.stringify({
                  saved: true,
                  resolved: result.issue_resolved,
                  next_question: result.next_question,
                  instruction: nextIssueId
                    ? "If the current detail is resolved, ask the next question exactly as provided. If it remains unresolved, ask the same question again more simply."
                    : "All blocking details are resolved. Tell the caregiver they can review the update now, then do not ask anything else.",
                }),
                is_error: false,
              }));
              setStatus(nextIssueId ? "Answer saved. Continuing with the next detail." : "All blocking details are clear. You can review the update.");
              setState("listening");
              readyRef.current = true;
            } catch (cause) {
              const messageText = cause instanceof Error ? cause.message : "That answer could not be saved.";
              setError(messageText);
              socket.send(JSON.stringify({ type: "tool.result", call_id: tool.call_id, result: JSON.stringify({ saved: false, error: messageText }), is_error: true }));
              setState("listening");
              readyRef.current = true;
            }
          })();
        } else if (message.type === "session.error" || message.type === "error") {
          readyRef.current = false;
          setError(typeof message.message === "string" ? message.message : "The voice session encountered an error.");
          setState(null);
        } else if (message.type === "session.ended") {
          setState(null);
          readyRef.current = false;
        }
      };
      socket.onerror = () => {
        setError("Could not connect to Voice Agent. Check microphone access and AssemblyAI Voice Agent account access.");
        setState(null);
        cleanup(false);
      };
      socket.onclose = () => {
        if (readyRef.current) setError("The voice connection closed. You can return to the draft and try again.");
        readyRef.current = false;
        setState(null);
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Voice clarification could not start.");
      cleanup(false);
    } finally {
      setBusy(false);
    }
  }, [cleanup, draftId]);

  function finish(): void {
    cleanup(true);
    onReview();
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 pb-8 pt-5 sm:px-6">
      <header><Button variant="ghost" onClick={() => { cleanup(true); onBack(); }}><ArrowLeft data-icon="inline-start" aria-hidden />Back to review</Button></header>
      <section className="mt-8 flex flex-col items-center text-center">
        <div className="relative size-48"><Orb className="absolute inset-0" colors={["#64c8b8", "#a7e2d8"]} agentState={state} /></div>
        <h1 className="mt-5 text-2xl font-semibold">Quick clarification</h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{status}</p>
      </section>
      {error && <Card className="mt-6 border-destructive/40"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><CircleAlert className="size-4" aria-hidden />Voice session issue</CardTitle><CardDescription>{error}</CardDescription></CardHeader></Card>}
      <Card className="mt-6"><CardContent className="flex flex-col gap-3 p-4">
        {!state ? (
          <Button size="lg" onClick={() => void start()} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden /> : <Mic data-icon="inline-start" aria-hidden />}
            {busy ? "Starting..." : "Start voice clarification"}
          </Button>
        ) : (
          <Button size="lg" variant="outline" onClick={finish}><MicOff data-icon="inline-start" aria-hidden />Finish and review</Button>
        )}
        <p className="text-center text-xs text-muted-foreground">You can stop at any time; unanswered details will stay flagged in your review.</p>
      </CardContent></Card>
    </main>
  );
}
