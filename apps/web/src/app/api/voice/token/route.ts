import { pingDatabase } from "@/lib/db";
import { listKnownExpressions } from "@/lib/expressions";
import { ApiError, handle, jsonOk } from "@/lib/http";
import { patientPreferredUnits, requireSession, sessionPatient } from "@/lib/session";
import { buildVoiceSession, ANSWER_TURN, mintVoiceToken, RECORDING_TURN, VoiceTokenError } from "@/lib/voice";

// Short-lived browser token plus the session configuration the browser opens: system prompt,
// transcription context, key terms, and the generated tool definitions (spec/05).
// The AssemblyAI API key never leaves the server (FR-011).
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const url = new URL(request.url);
    const patient = await sessionPatient(session, url.searchParams.get("patient_id"));
    try {
      // Warm the database while the browser connects: tool calls run inside a spoken
      // turn, so a cold Neon compute resume here would surface as reply latency.
      const [token, expressions] = await Promise.all([
        mintVoiceToken(),
        listKnownExpressions(session.caregiverId, patient.id),
        pingDatabase(),
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
        // Sibling of session (never sent inside it): the two turn-detection postures the
        // browser swaps between on Speak/Done. Kept server-side so both stay in one place.
        turn: { recording: RECORDING_TURN, answer: ANSWER_TURN },
      });
    } catch (error) {
      if (error instanceof VoiceTokenError) {
        throw new ApiError(error.status, "voice_unavailable", error.message);
      }
      throw error;
    }
  });
}
