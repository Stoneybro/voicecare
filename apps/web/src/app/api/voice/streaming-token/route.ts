// Temporary token + config for Stage 1 medical dictation (pure recording + live
// transcription, no turn-by-turn chat).
//
// The browser opens its own WebSocket to AssemblyAI Streaming STT:
//   wss://streaming.assemblyai.com/v3/ws?token=...&sample_rate=16000
//     &speech_model=universal-3-5-pro&domain=medical-v1&...
// The AssemblyAI API key never leaves the server. Tokens are single-use.

import { listKnownExpressions } from "@/lib/expressions";
import { ApiError, handle, jsonOk } from "@/lib/http";
import { requireSession, sessionPatient } from "@/lib/session";
import { buildKeyTerms, buildTranscriptionPrompt } from "@/lib/voice";

const STREAMING_TOKEN_ENDPOINT = "https://streaming.assemblyai.com/v3/token";

// Medical dictation posture for caregiver voice notes. Caregivers pause mid-note
// while reading a device, so use the documented medical turn-detection tuning:
// longer silence tolerance than fast voice-agent dialogue, but turns still split
// so live captions stay readable. Splits are harmless here — finals accumulate.
const STREAMING_CONFIG = {
  sample_rate: 16000,
  speech_model: "universal-3-5-pro",
  domain: "medical-v1",
  min_turn_silence: 800,
  max_turn_silence: 3600,
} as const;

function tokenTtlSeconds(): number {
  const parsed = Number(process.env.VOICE_AGENT_TOKEN_TTL_SECONDS ?? "120");
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), 600)) : 120;
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new ApiError(503, "voice_not_configured", "Voice transcription is not configured. Type your observation instead.");
    }

    const expressions = await listKnownExpressions(session.caregiverId, patient.id).catch(() => []);
    const tokenUrl = new URL(STREAMING_TOKEN_ENDPOINT);
    tokenUrl.searchParams.set("expires_in_seconds", String(tokenTtlSeconds()));
    tokenUrl.searchParams.set("max_session_duration_seconds", "600");

    let response: Response;
    try {
      // Streaming tokens use the raw API key (no Bearer prefix).
      response = await fetch(tokenUrl, { headers: { Authorization: apiKey } });
    } catch (error) {
      console.error("[voicecare] streaming token request failed", error);
      throw new ApiError(503, "voice_unavailable", "The transcription service could not be reached. Type your observation instead.");
    }
    if (!response.ok) {
      console.error("[voicecare] streaming token rejected", response.status);
      throw new ApiError(502, "voice_unavailable", "The transcription service refused the session request. Type your observation instead.");
    }
    const payload = (await response.json()) as { token?: unknown };
    if (typeof payload.token !== "string" || !payload.token) {
      console.error("[voicecare] streaming token response had no token");
      throw new ApiError(502, "voice_unavailable", "The transcription service returned an unusable session. Type your observation instead.");
    }

    return jsonOk({
      token: payload.token,
      streaming: {
        ...STREAMING_CONFIG,
        keyterms_prompt: buildKeyTerms(patient.display_name, expressions),
        prompt: buildTranscriptionPrompt(patient.display_name),
      },
    });
  });
}
