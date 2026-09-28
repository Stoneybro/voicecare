"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle, Mic, MicOff, Sparkles } from "lucide-react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Props = { draftId: string; mode?: "clarification" | "confirmation" | "expression"; candidateId?: string; onBack: () => void; onReview: () => void };
type VoiceConfig = { system_prompt: string; greeting: string; input: object; output: object; tools: object[] };
type TokenPayload = { token: string; issue_id: string | null; candidate_id: string | null; mode: "clarification" | "confirmation" | "expression"; question: string | null; session: VoiceConfig };
type ToolCall = { call_id: string; name: string; arguments: { answer?: string } };
type Suggestion = { suggestion_id: string; phrase: string; measurement_type: string; unit: string | null; patient_name: string };

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

export function VoiceAssistantPanel({ draftId, mode = "clarification", candidateId, onBack, onReview }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, []);
  const [state, setState] = useState<AgentState>(null);
  const [status, setStatus] = useState(mode === "confirmation"
    ? "Start when ready to hear the draft summary and confirm it by voice."
    : mode === "expression"
      ? "Tell VoiceCare what this unusual phrase means. It will not guess or save anything yet."
      : "Start when you're ready. VoiceCare will ask only about details that need clarification.");
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [savingSuggestion, setSavingSuggestion] = useState(false);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackTimeRef = useRef(0);
  const readyRef = useRef(false);
  const issueIdRef = useRef("");
  const sessionIdRef = useRef<string | null>(null);
  const pendingToolRef = useRef<ToolCall | null>(null);
  const confirmationReplyRef = useRef(false);
  const expressionReplyRef = useRef(false);
  const autoStartRequestedRef = useRef(false);
  const clarificationCompleteReplyRef = useRef(false);
  const autoReviewTimerRef = useRef<number | null>(null);

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

  useEffect(() => () => {
    if (autoReviewTimerRef.current !== null) window.clearTimeout(autoReviewTimerRef.current);
    cleanup(true);
  }, [cleanup]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus("Preparing your microphone and connecting...");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access needs a secure browser connection.");
      const tokenUrl = new URL("/api/agent-token", window.location.origin);
      tokenUrl.searchParams.set("draft_id", draftId);
      tokenUrl.searchParams.set("mode", mode);
      if (mode === "expression" && candidateId) tokenUrl.searchParams.set("candidate_id", candidateId);
      const response = await fetch(tokenUrl, { cache: "no-store" });
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
      issueIdRef.current = payload.issue_id ?? "";
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
          sessionIdRef.current = typeof message.session_id === "string" ? message.session_id : null;
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
        } else if (message.type === "tool.call" && message.name === (mode === "confirmation" ? "confirm_draft" : mode === "expression" ? "submit_expression_meaning" : "submit_clarification_answer")) {
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
              const saveResponse = await fetch(mode === "confirmation"
                ? `/api/drafts/${encodeURIComponent(draftId)}/confirm`
                : mode === "expression"
                  ? `/api/drafts/${encodeURIComponent(draftId)}/expressions/clarify`
                  : `/api/drafts/${encodeURIComponent(draftId)}/clarify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(mode === "confirmation"
                  ? { method: "voice", answer, session_id: sessionIdRef.current }
                  : mode === "expression"
                    ? { candidate_id: candidateId, answer }
                    : { issue_id: issueIdRef.current, answer, session_id: sessionIdRef.current }),
              });
              const result = await saveResponse.json().catch(() => null);
              if (!saveResponse.ok) throw new Error(messageFrom(result, "That answer could not be saved."));
              if (mode === "expression" && result?.expression_suggestion) setSuggestion(result.expression_suggestion as Suggestion);
              if (mode === "clarification" && result?.expression_suggestion) setSuggestion(result.expression_suggestion as Suggestion);
              const nextIssueId = mode === "clarification" && typeof result.next_issue_id === "string" ? result.next_issue_id : null;
              const allBlockingDetailsClear = mode === "clarification" && result.issue_resolved === true && !nextIssueId;
              if (nextIssueId) issueIdRef.current = nextIssueId;
              if (allBlockingDetailsClear) clarificationCompleteReplyRef.current = true;
              socket.send(JSON.stringify({
                type: "tool.result",
                call_id: tool.call_id,
                result: JSON.stringify({
                  saved: true,
                  resolved: mode === "expression" ? result.resolved : result.issue_resolved,
                  next_question: result.next_question,
                  instruction: mode === "confirmation"
                    ? "The draft is confirmed. Thank the caregiver briefly, then finish the conversation."
                    : mode === "expression"
                      ? result.resolved
                        ? "Thank the caregiver for explaining the phrase. Tell them to review the suggested mapping before saving it. Do not say it has been remembered."
                        : "Thank the caregiver. Tell them they can choose the meaning from the list on the review screen. Do not suggest a meaning."
                    : nextIssueId
                      ? "If the current detail is resolved, ask the next question exactly as provided. If it remains unresolved, ask the same question again more simply."
                      : result.issue_resolved === true
                        ? "All blocking details are resolved. Tell the caregiver they can review the update now, then do not ask anything else."
                        : "That answer did not resolve the detail. Ask the same question again more simply. Do not say the update is ready to review.",
                }),
                is_error: false,
              }));
              if (mode === "confirmation") {
                confirmationReplyRef.current = true;
                setStatus("Confirmation saved. Wrapping up...");
              } else if (mode === "expression") {
                expressionReplyRef.current = true;
                setStatus(result.resolved ? "Explanation received. Review the suggested mapping before saving." : "You can choose the meaning from the list on the review screen.");
              } else {
                setStatus(nextIssueId
                  ? "Answer saved. Continuing with the next detail."
                  : result.issue_resolved === true
                    ? "All blocking details are clear. Returning to your review..."
                    : "That detail still needs clarification. Try answering in a different way.");
              }
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
        } else if (message.type === "reply.done" && confirmationReplyRef.current && !pendingToolRef.current) {
          confirmationReplyRef.current = false;
          cleanup(true);
          onReview();
        } else if (message.type === "reply.done" && expressionReplyRef.current && !pendingToolRef.current) {
          expressionReplyRef.current = false;
          cleanup(true);
          onReview();
        } else if (message.type === "reply.done" && clarificationCompleteReplyRef.current && !pendingToolRef.current) {
          clarificationCompleteReplyRef.current = false;
          const remainingAudioMs = contextRef.current
            ? Math.max(0, playbackTimeRef.current - contextRef.current.currentTime) * 1000
            : 0;
          autoReviewTimerRef.current = window.setTimeout(() => {
            autoReviewTimerRef.current = null;
            cleanup(true);
            onReview();
          }, remainingAudioMs + 150);
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
        cleanup(true);
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
  }, [candidateId, cleanup, draftId, mode, onReview]);

  useEffect(() => {
    if (autoStartRequestedRef.current) return;
    autoStartRequestedRef.current = true;
    void start();
  }, [start]);

  function finish(): void {
    if (autoReviewTimerRef.current !== null) window.clearTimeout(autoReviewTimerRef.current);
    autoReviewTimerRef.current = null;
    cleanup(true);
    onReview();
  }

  async function rememberExpression(): Promise<void> {
    if (!suggestion || savingSuggestion) return;
    setSavingSuggestion(true);
    try {
      const response = await fetch("/api/expressions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft_id: draftId, suggestion_id: suggestion.suggestion_id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(messageFrom(payload, "That phrase could not be remembered."));
      setSuggestion(null);
      setStatus(`I’ll remember “${suggestion.phrase}” for ${suggestion.patient_name}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That phrase could not be remembered.");
    } finally {
      setSavingSuggestion(false);
    }
  }

  return (
    <section ref={panelRef} tabIndex={-1} className="care-voice-panel" aria-label="Voice assistant">
      <header><Button variant="ghost" onClick={() => { cleanup(true); onBack(); }}><ArrowLeft data-icon="inline-start" aria-hidden />Close voice assistant</Button></header>
      <section className="mt-8 flex flex-col items-center text-center">
        <div className="relative size-32"><Orb className="absolute inset-0" colors={["#7c9463", "#c3cea8"]} agentState={state} /></div>
        <h2 className="mt-5 text-xl font-semibold">{mode === "confirmation" ? "Confirm by voice" : mode === "expression" ? "Explain a phrase" : "A little more detail"}</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{status}</p>
      </section>
      {error && <Card className="mt-6 border-destructive/40"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><CircleAlert className="size-4" aria-hidden />Voice session issue</CardTitle><CardDescription>{error}</CardDescription></CardHeader></Card>}
      {suggestion && <Card className="mt-6 border-primary/30"><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4" aria-hidden />Remember this?</CardTitle><CardDescription>Remember that “{suggestion.phrase}” means {suggestion.measurement_type.replaceAll("_", " ")} for {suggestion.patient_name}?</CardDescription></CardHeader><CardContent className="flex gap-2"><Button className="flex-1" onClick={() => void rememberExpression()} disabled={savingSuggestion}>{savingSuggestion ? "Saving…" : "Yes, remember"}</Button><Button variant="outline" onClick={() => setSuggestion(null)} disabled={savingSuggestion}>Not now</Button></CardContent></Card>}
      <Card className="mt-6"><CardContent className="flex flex-col gap-3 p-4">
        {!state ? (
          <Button size="lg" onClick={() => void start()} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden /> : <Mic data-icon="inline-start" aria-hidden />}
            {busy ? "Starting..." : mode === "confirmation" ? "Hear the summary" : mode === "expression" ? "Explain by voice" : "Start voice clarification"}
          </Button>
        ) : (
          <Button size="lg" variant="outline" onClick={finish}><MicOff data-icon="inline-start" aria-hidden />Finish and review</Button>
        )}
        <p className="text-center text-xs text-muted-foreground">{mode === "confirmation" ? "Only a clear yes confirms. Say no to return and make corrections." : mode === "expression" ? "This explanation will only create a suggestion. VoiceCare will ask before remembering it." : "You can stop at any time; unanswered details will stay flagged in your review."}</p>
      </CardContent></Card>
    </section>
  );
}
