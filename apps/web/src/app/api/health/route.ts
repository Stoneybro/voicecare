import { isDatabaseConfigured, pingDatabase } from "@/lib/db";
import { handle, jsonOk } from "@/lib/http";
import { isVoiceConfigured } from "@/lib/voice";
import type { HealthResponse } from "@voicecare/shared";

// Application and database readiness without exposing secrets or sensitive details
// (spec/07 "Unattended deployment checks"). The home screen waits for this before
// showing "Ready to speak".
export async function GET(): Promise<Response> {
  return handle(async () => {
    const databaseReady = await pingDatabase();
    const payload: HealthResponse = {
      status: !isDatabaseConfigured() || !databaseReady ? "degraded" : "ready",
      database: !isDatabaseConfigured() ? "not_configured" : databaseReady ? "ready" : "unavailable",
      voice: isVoiceConfigured() ? "ready" : "not_configured",
      checked_at: new Date().toISOString(),
      message: databaseReady
        ? isVoiceConfigured()
          ? "VoiceCare is ready."
          : "VoiceCare is ready. Voice sessions are not configured, so typed observations are available."
        : "The demo database is waking up. Please wait a moment and try again.",
    };
    return jsonOk(payload);
  });
}
