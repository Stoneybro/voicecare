import { getSql } from "@/lib/db";
import { clarificationPrompt, clarificationQuestion, type ClarificationIssue } from "@/lib/clarification";
import { ApiError, handle, jsonOk } from "@/lib/http";
import { requireSession } from "@/lib/session";

const DEFAULT_TOKEN_TTL_SECONDS = 120;
const DEFAULT_MAX_SESSION_SECONDS = 600;

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const draftId = new URL(request.url).searchParams.get("draft_id");
    if (!draftId) throw new ApiError(400, "draft_id_required", "Choose a draft before starting clarification.");

    const rows = (await getSql()`
      select id, status, unresolved_issues
      from drafts
      where id = ${draftId} and caregiver_id = ${session.caregiverId}
      limit 1
    `) as Array<{ id: string; status: string; unresolved_issues: unknown }>;
    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
    if (draft.status !== "NEEDS_CLARIFICATION") {
      throw new ApiError(409, "clarification_not_needed", "This draft has no details waiting for clarification.");
    }
    const issues = Array.isArray(draft.unresolved_issues) ? draft.unresolved_issues as ClarificationIssue[] : [];
    if (!issues.length) throw new ApiError(409, "no_open_issues", "This draft has no unresolved details.");

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) throw new ApiError(503, "voice_agent_not_configured", "Voice clarification is not configured yet.");

    const expiresIn = boundedInteger(process.env.VOICE_AGENT_TOKEN_TTL_SECONDS, DEFAULT_TOKEN_TTL_SECONDS, 1, 600);
    const maxSessionDuration = boundedInteger(process.env.VOICE_AGENT_MAX_SESSION_SECONDS, DEFAULT_MAX_SESSION_SECONDS, 60, 10_800);
    const tokenUrl = new URL("https://agents.assemblyai.com/v1/token");
    tokenUrl.searchParams.set("expires_in_seconds", String(expiresIn));
    tokenUrl.searchParams.set("max_session_duration_seconds", String(maxSessionDuration));
    const providerResponse = await fetch(tokenUrl, {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!providerResponse.ok) {
      console.error("[voicecare] AssemblyAI Voice Agent token request failed", providerResponse.status);
      throw new ApiError(502, "voice_agent_unavailable", "Voice clarification could not start. You can still review the unresolved details.");
    }
    const payload: unknown = await providerResponse.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !("token" in payload) || typeof payload.token !== "string") {
      throw new ApiError(502, "voice_agent_token_invalid", "Voice clarification could not start. Please try again.");
    }

    return jsonOk({
      token: payload.token,
      issue_id: issues[0].id,
      question: clarificationQuestion(issues),
      session: {
        system_prompt: clarificationPrompt(issues),
        greeting: `I have one detail to clarify. ${clarificationQuestion(issues)}`,
        input: { format: { encoding: "audio/pcm" }, voice_focus: "near-field" },
        output: { voice: process.env.VOICE_AGENT_VOICE || "alba", format: { encoding: "audio/pcm" } },
        tools: [{
          type: "function",
          name: "submit_clarification_answer",
          description: "Save the caregiver's answer to the current clarification question, then continue with the next open question if any.",
          parameters: {
            type: "object",
            properties: { answer: { type: "string", description: "The caregiver's answer, transcribed verbatim." } },
            required: ["answer"],
          },
        }],
      },
    }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
