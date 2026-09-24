// Transcribe a locally-recorded audio blob using AssemblyAI's async STT API with
// Medical Mode (domain medical-v1).
//
// This is the Stage 1 fallback: when live medical streaming fails or returns no
// speech, the locally-recorded MediaRecorder blob is uploaded here so the Done
// handoff still has a transcript. Primary path is live streaming
// (POST /api/voice/streaming-token -> wss://streaming.assemblyai.com/v3/ws).
//
// POST /api/voice/transcribe
//   Body: FormData { audio: Blob }
//   Response: { text: string }

import { handle, jsonOk, ApiError } from "@/lib/http";
import { requireSession } from "@/lib/session";

const ASSEMBLYAI_BASE = "https://api.assemblyai.com";
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_ATTEMPTS = 200; // up to 5 minutes of polling

function apiKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new ApiError(503, "voice_not_configured", "Voice transcription is not configured.");
  return key;
}

async function uploadAudio(audioBytes: ArrayBuffer, key: string): Promise<string> {
  const response = await fetch(`${ASSEMBLYAI_BASE}/v2/upload`, {
    method: "POST",
    headers: {
      Authorization: key,
      "Content-Type": "application/octet-stream",
    },
    body: audioBytes,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    console.error("[voicecare] AssemblyAI upload failed", response.status, body);
    throw new ApiError(502, "transcription_upload_failed", `Upload failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as { upload_url?: string };
  if (!payload.upload_url) throw new ApiError(502, "transcription_upload_failed", "No upload URL returned.");
  return payload.upload_url;
}

async function submitTranscript(audioUrl: string, key: string): Promise<string> {
  const response = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_model: "best",
      language_detection: true,
      // Medical Mode: boost medication names, conditions, dosages on the fallback
      // path too, matching the live streaming session (domain medical-v1).
      domain: "medical-v1",
      keyterms_prompt: [
        "blood pressure",
        "blood glucose",
        "blood sugar",
        "temperature",
        "heart rate",
        "oxygen saturation",
      ],
    }),
  });
  if (!response.ok) {
    console.error("[voicecare] AssemblyAI transcript submit failed", response.status);
    throw new ApiError(502, "transcription_failed", "The transcription request was rejected.");
  }
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new ApiError(502, "transcription_failed", "No transcription ID returned.");
  return payload.id;
}

async function pollUntilDone(transcriptId: string, key: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const response = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript/${transcriptId}`, {
      headers: { Authorization: key },
    });
    if (!response.ok) {
      console.error("[voicecare] AssemblyAI poll failed", response.status);
      throw new ApiError(502, "transcription_failed", "Could not check transcription status.");
    }
    const payload = (await response.json()) as {
      status?: string;
      text?: string;
      error?: string;
    };
    if (payload.status === "completed") {
      return payload.text ?? "";
    }
    if (payload.status === "error") {
      console.error("[voicecare] AssemblyAI transcription error", payload.error);
      throw new ApiError(502, "transcription_failed", "Transcription failed: " + (payload.error ?? "unknown error"));
    }
    // status is "queued" or "processing" — keep polling
  }
  throw new ApiError(504, "transcription_timeout", "Transcription took too long. Please try again.");
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    // Require a valid session so the endpoint can't be abused.
    await requireSession();

    const key = apiKey();

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new ApiError(400, "invalid_request", "Expected a multipart/form-data body with an 'audio' field.");
    }

    const audioField = formData.get("audio");
    if (!(audioField instanceof Blob)) {
      throw new ApiError(400, "missing_audio", "No audio blob found in the request.");
    }
    if (audioField.size === 0) {
      throw new ApiError(400, "empty_audio", "The audio recording is empty.");
    }

    const audioBytes = await audioField.arrayBuffer();
    console.log("[voicecare] transcribe: audio blob size", audioBytes.byteLength, "bytes");
    if (audioBytes.byteLength === 0) {
      throw new ApiError(400, "empty_audio", "The recorded audio is empty.");
    }
    const uploadUrl = await uploadAudio(audioBytes, key);
    const transcriptId = await submitTranscript(uploadUrl, key);
    const text = await pollUntilDone(transcriptId, key);

    return jsonOk({ text: text.trim() });
  });
}
