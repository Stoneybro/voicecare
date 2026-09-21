import { listKnownExpressions } from "@/lib/expressions";
import { ApiError, handle, jsonOk } from "@/lib/http";
import { patientPreferredUnits, requireSession, sessionPatient } from "@/lib/session";
import { buildVoiceSession, mintVoiceToken, VoiceTokenError } from "@/lib/voice";

// Short-lived browser token plus the session configuration the browser opens: system prompt,
// transcription context, key terms, and the generated tool definitions (spec/05).
// The AssemblyAI API key never leaves the server (FR-011).
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));
    try {
      const [token, expressions] = await Promise.all([
        mintVoiceToken(),
        listKnownExpressions(session.caregiverId, patient.id),
      ]);
      return jsonOk({
        token: token.token,
        expires_in: token.expires_in,
        session: buildVoiceSession({
          patient,
          preferredUnits: patientPreferredUnits(patient),
          expressions,
          timeZone: session.timezone,
        }),
      });
    } catch (error) {
      if (error instanceof VoiceTokenError) {
        throw new ApiError(error.status, "voice_unavailable", error.message);
      }
      throw error;
    }
  });
}
