"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Check, LoaderCircle, Mic, MicOff, Radio, RotateCcw, Type } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/ui/orb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type RecordingScreenProps = {
  patientId: string;
  patientName: string;
  onCancel: () => void;
  onSaved: (draftId: string) => void;
};

type ScreenMode = "ready" | "connecting" | "live" | "fallback" | "saving";

type SttMessage = {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  turn_order?: number;
  error?: string;
};

function errorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

function resampleToPcm16(input: Float32Array, inputRate: number, outputRate: number): ArrayBuffer {
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const pcm = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += input[sample];
    const average = end > start ? sum / (end - start) : input[start] ?? 0;
    const clipped = Math.max(-1, Math.min(1, average));
    pcm[index] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
  }

  return pcm.buffer;
}

export function RecordingScreen({ patientId, patientName, onCancel, onSaved }: RecordingScreenProps) {
  const [mode, setMode] = useState<ScreenMode>("ready");
  const [transcript, setTranscript] = useState("");
  const [typedTranscript, setTypedTranscript] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const draftIdRef = useRef<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const finalTurnsRef = useRef<Map<number, string>>(new Map());
  const partialTurnRef = useRef("");
  const disposedRef = useRef(false);
  const savingRef = useRef(false);
  const transcriptRef = useRef("");
  const startTimeRef = useRef<number | null>(null);

  const updateTranscript = useCallback(() => {
    const finalized = [...finalTurnsRef.current.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join(" ");
    const next = [finalized, partialTurnRef.current.trim()].filter(Boolean).join(" ");
    transcriptRef.current = next;
    setTranscript(next);
  }, []);

  const stopAudio = useCallback(async (sendTerminate = true) => {
    const processor = processorRef.current;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      processorRef.current = null;
    }
    const stream = mediaStreamRef.current;
    stream?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && sendTerminate) {
      socket.send(JSON.stringify({ type: "Terminate" }));
    }
  }, []);

  const switchToFallback = useCallback(
    async (message: string) => {
      const socket = socketRef.current;
      await stopAudio();
      startTimeRef.current = null;
      if (socket && socket.readyState < WebSocket.OPEN) socket.close();
      setStatusMessage(message);
      setTypedTranscript(transcriptRef.current);
      setMode("fallback");
    },
    [stopAudio],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (startTimeRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      void stopAudio(false);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }, [stopAudio]);

  async function createDraft(): Promise<string> {
    const response = await fetch("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patient_id: patientId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload.draft_id !== "string") {
      throw new Error(errorMessage(payload, "Could not start this note. Please try again."));
    }
    draftIdRef.current = payload.draft_id;
    return payload.draft_id;
  }

  async function startRecording(): Promise<void> {
    if (mode !== "ready" && mode !== "fallback") return;
    disposedRef.current = false;
    setMode("connecting");
    setStatusMessage("Preparing a secure recording…");

    // Ask for the microphone directly from this click so browsers can show their permission UI.
    const mediaPromise = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      : Promise.reject(new Error("This browser cannot access a microphone."));
    const draftPromise = draftIdRef.current ? Promise.resolve(draftIdRef.current) : createDraft();
    const [draftResult, mediaResult] = await Promise.allSettled([draftPromise, mediaPromise]);

    if (disposedRef.current) {
      if (mediaResult.status === "fulfilled") mediaResult.value.getTracks().forEach((track) => track.stop());
      if (draftResult.status === "fulfilled") {
        await fetch(`/api/drafts/${encodeURIComponent(draftResult.value)}`, { method: "DELETE" }).catch(() => undefined);
      }
      return;
    }

    if (draftResult.status === "rejected") {
      if (mediaResult.status === "fulfilled") mediaResult.value.getTracks().forEach((track) => track.stop());
      setMode("ready");
      setStatusMessage(draftResult.reason instanceof Error ? draftResult.reason.message : "Could not start this note.");
      return;
    }

    if (mediaResult.status === "rejected") {
      await switchToFallback("Microphone access is unavailable. Type what you want to record below.");
      return;
    }

    const stream = mediaResult.value;
    mediaStreamRef.current = stream;

    try {
      setStatusMessage("Connecting to live transcription…");
      const tokenResponse = await fetch("/api/stt-token", { cache: "no-store" });
      const tokenPayload = await tokenResponse.json().catch(() => null);
      if (!tokenResponse.ok || !tokenPayload || typeof tokenPayload.token !== "string") {
        throw new Error(errorMessage(tokenPayload, "Live transcription is unavailable. You can type your note instead."));
      }

      const query = new URLSearchParams({
        sample_rate: "16000",
        speech_model: "universal-streaming-english",
        domain: "medical-v1",
        token: tokenPayload.token,
      });
      const socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${query.toString()}`);
      socketRef.current = socket;

      await new Promise<void>((resolve, reject) => {
        const connectionTimeout = window.setTimeout(() => reject(new Error("The transcription service took too long to connect.")), 12_000);
        let connected = false;
        socket.onopen = () => {
          connected = true;
          window.clearTimeout(connectionTimeout);
          resolve();
        };
        socket.onerror = () => {
          window.clearTimeout(connectionTimeout);
          reject(new Error("Could not connect to live transcription."));
        };
        socket.onclose = (event) => {
          window.clearTimeout(connectionTimeout);
          if (!connected) {
            reject(new Error("Could not connect to live transcription."));
            return;
          }
          if (!disposedRef.current && !savingRef.current) {
            const detail = event.reason ? ` (${event.reason})` : "";
            void switchToFallback(`Live transcription disconnected${detail}. Your note can still be typed and saved.`);
          }
        };
        socket.onmessage = (event: MessageEvent<string>) => {
          let message: SttMessage;
          try {
            message = JSON.parse(event.data) as SttMessage;
          } catch {
            return;
          }

          if (message.type === "Turn" && typeof message.transcript === "string") {
            const turnOrder = typeof message.turn_order === "number" ? message.turn_order : finalTurnsRef.current.size;
            if (message.end_of_turn) {
              finalTurnsRef.current.set(turnOrder, message.transcript);
              partialTurnRef.current = "";
            } else {
              partialTurnRef.current = message.transcript;
            }
            updateTranscript();
          } else if (message.type === "Termination") {
            updateTranscript();
          } else if (message.type === "Error") {
            void switchToFallback(message.error || "Live transcription stopped. Type your note below to continue.");
          }
        };
      });

      if (disposedRef.current) {
        socket.close();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Live transcription disconnected before recording began.");
      }

      const context = new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(8192, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
        socket.send(resampleToPcm16(input, context.sampleRate, 16_000));
      };
      source.connect(processor);
      processor.connect(context.destination);
      startTimeRef.current = Date.now();
      setStatusMessage("Listening. Speak naturally; you can pause whenever you need.");
      setMode("live");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Live transcription could not start.";
      await switchToFallback(`${message} Type your note below to continue.`);
    }
  }

  async function startTextEntry(): Promise<void> {
    setMode("connecting");
    setStatusMessage("Preparing a secure draft...");
    try {
      if (!draftIdRef.current) await createDraft();
      setStatusMessage("Type your update below, then save it as a draft.");
      setMode("fallback");
    } catch (error) {
      setMode("ready");
      setStatusMessage(error instanceof Error ? error.message : "Could not start this note. Please try again.");
    }
  }

  async function stopAndSave(): Promise<void> {
    const finalText = (mode === "fallback" ? typedTranscript : transcriptRef.current).trim();
    if (!finalText) {
      toast.error("Add a few words before saving this note.");
      return;
    }
    if (!draftIdRef.current || savingRef.current) return;
    savingRef.current = true;
    setMode("saving");
    setStatusMessage("Saving your transcript…");

    const socket = socketRef.current;
    await stopAudio();
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 1200);
        const previousMessageHandler = socket.onmessage;
        socket.onmessage = (event) => {
          previousMessageHandler?.call(socket, event);
          try {
            if ((JSON.parse(event.data) as SttMessage).type === "Termination") {
              window.clearTimeout(timeout);
              resolve();
            }
          } catch {
            // Ignore any final non-JSON provider message and let the short flush timeout finish.
          }
        };
      });
    }
    socketRef.current?.close();
    socketRef.current = null;

    // Include any final partial received during the provider's termination flush.
    const transcriptToSave = mode === "fallback" ? typedTranscript.trim() : transcriptRef.current.trim();
    try {
      const response = await fetch(`/api/drafts/${encodeURIComponent(draftIdRef.current)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ original_transcript: transcriptToSave || finalText }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "Could not save this transcript. Please try again."));
      toast.success("Transcript saved as a draft.");
      onSaved(draftIdRef.current);
    } catch (error) {
      savingRef.current = false;
      setMode("fallback");
      setTypedTranscript(transcriptToSave || finalText);
      setStatusMessage(error instanceof Error ? error.message : "Could not save this transcript.");
    }
  }

  async function cancelRecording(): Promise<void> {
    disposedRef.current = true;
    await stopAudio();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    if (draftIdRef.current) {
      await fetch(`/api/drafts/${encodeURIComponent(draftIdRef.current)}`, { method: "DELETE" }).catch(() => undefined);
    }
    onCancel();
  }

  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");
  const displayedTranscript = mode === "fallback" ? typedTranscript : transcript;

  return (
    <main className="fixed inset-0 z-50 flex min-h-dvh flex-col overflow-y-auto bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
        <Button variant="ghost" onClick={() => void cancelRecording()} disabled={mode === "saving"}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          Cancel
        </Button>
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Mic className="size-4" aria-hidden />
          </span>
          Recording for {patientName}
        </div>
        <span className="w-16 text-right font-mono text-xs tabular-nums text-muted-foreground" aria-label={`Recording time ${minutes}:${seconds}`}>
          {minutes}:{seconds}
        </span>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-8 sm:px-6">
        <section className="flex flex-col items-center pt-3 text-center sm:pt-8">
          <div className="relative size-40 sm:size-48">
            <Orb
              className="absolute inset-0"
              colors={["#64c8b8", "#a7e2d8"]}
              agentState={mode === "live" ? "listening" : mode === "connecting" ? "thinking" : null}
            />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {mode === "live" ? "I’m listening" : mode === "fallback" ? "Your note, your words" : "Let’s capture an update"}
          </h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground" aria-live="polite">
            {statusMessage || (mode === "ready" ? `Share how ${patientName} has been doing.` : "Preparing your recording…")}
          </p>

          {mode === "ready" && (
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Button size="lg" className="rounded-full px-6" onClick={() => void startRecording()}>
                <Mic data-icon="inline-start" aria-hidden />
                Start recording
              </Button>
              <Button variant="outline" size="lg" className="rounded-full px-6" onClick={() => void startTextEntry()}>
                <Type data-icon="inline-start" aria-hidden />
                Type instead
              </Button>
            </div>
          )}

          {mode === "connecting" && (
            <div className="mt-5 flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Connecting securely
            </div>
          )}

          {mode === "live" && (
            <div className="mt-5 flex h-10 items-center justify-center gap-1.5" aria-label="Microphone waveform">
              {Array.from({ length: 25 }, (_, index) => (
                <span
                  key={index}
                  aria-hidden
                  className="waveform-bar w-1 rounded-full bg-primary/75"
                  style={{
                    "--bar-index": index,
                    "--bar-height": `${0.75 + ((index * 7) % 5) * 0.22}rem`,
                  } as CSSProperties & Record<"--bar-height", string>}
                />
              ))}
            </div>
          )}
        </section>

        <Card className="mt-5 flex min-h-48 flex-1 flex-col sm:mt-7">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {mode === "fallback" ? <Type className="size-4 text-primary" aria-hidden /> : <Radio className="size-4 text-primary" aria-hidden />}
              {mode === "fallback" ? "Type your update" : "Live transcript"}
            </CardTitle>
            <CardDescription>
              {mode === "fallback" ? "Your text is saved as the original transcript for this draft." : "Your words appear here as they are recognized. You can correct them in the next step."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col pb-4">
            {mode === "fallback" ? (
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="fallback-transcript" className="sr-only">Transcript text</Label>
                <textarea
                  id="fallback-transcript"
                  className="min-h-36 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-base leading-relaxed shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                  placeholder={`For example: ${patientName} had breakfast and said they felt tired this morning.`}
                  maxLength={30_000}
                  value={typedTranscript}
                  onChange={(event) => setTypedTranscript(event.target.value)}
                  autoFocus
                />
              </div>
            ) : (
              <div className="min-h-32 flex-1 whitespace-pre-wrap text-base leading-relaxed" aria-live="polite" aria-atomic="false">
                  {displayedTranscript ? (
                    displayedTranscript
                  ) : (
                  <p className="text-muted-foreground">
                    {mode === "live" ? "I’ll show each phrase here as you speak…" : mode === "connecting" ? "Your live transcript will appear here." : "Start a recording or choose text entry."}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {mode === "live" && (
          <Button variant="outline" className="mx-auto mt-4 rounded-full" onClick={() => void switchToFallback("You can edit the transcript here and save it as a draft.")}>
            <Type data-icon="inline-start" aria-hidden />
            Switch to text entry
          </Button>
        )}
        {mode === "fallback" && !transcript && (
          <Button variant="ghost" className="mx-auto mt-2" onClick={() => void startRecording()}>
            <RotateCcw data-icon="inline-start" aria-hidden />
            Try microphone again
          </Button>
        )}

        <div className="mt-5 flex justify-center">
          <Button
            size="lg"
            className="h-12 min-w-48 rounded-full px-7"
            onClick={() => void stopAndSave()}
            disabled={mode === "ready" || mode === "connecting" || mode === "saving"}
          >
            {mode === "saving" ? <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden /> : mode === "fallback" ? <Check data-icon="inline-start" aria-hidden /> : <MicOff data-icon="inline-start" aria-hidden />}
            {mode === "saving" ? "Saving draft…" : mode === "fallback" ? "Done · save draft" : "Done"}
          </Button>
        </div>
        <p className="mt-3 text-center text-xs text-muted-foreground">Fictional demo information only. This is not medical advice.</p>
      </div>
    </main>
  );
}
