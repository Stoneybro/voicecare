import { ApiError, handle, jsonOk } from "@/lib/http";
import { requireSession } from "@/lib/session";

const DEFAULT_TOKEN_TTL_SECONDS = 120;

function getTokenTtl(): number {
  const configured = Number(process.env.STT_TOKEN_TTL_SECONDS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 600
    ? configured
    : DEFAULT_TOKEN_TTL_SECONDS;
}

// The real API key stays on the server. This short-lived token can be redeemed once by the
// browser to open its own AssemblyAI streaming connection.
export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireSession();

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new ApiError(503, "stt_not_configured", "Live transcription is not configured. You can still type your note.");
    }

    const providerResponse = await fetch(
      `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${getTokenTtl()}`,
      {
        headers: { authorization: apiKey },
        cache: "no-store",
      },
    );

    if (!providerResponse.ok) {
      console.error("[voicecare] AssemblyAI token request failed", providerResponse.status);
      throw new ApiError(
        502,
        "stt_token_unavailable",
        "Live transcription is unavailable right now. You can type your note instead.",
      );
    }

    const payload: unknown = await providerResponse.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !("token" in payload) || typeof payload.token !== "string") {
      throw new ApiError(502, "stt_token_invalid", "Live transcription could not be started. You can type your note instead.");
    }

    return jsonOk({ token: payload.token }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
