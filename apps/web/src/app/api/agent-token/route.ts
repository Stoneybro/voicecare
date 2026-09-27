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
    const params = new URL(request.url).searchParams;
    const draftId = params.get("draft_id");
    const mode = params.get("mode") === "confirmation" ? "confirmation" : "clarification";
    if (!draftId) throw new ApiError(400, "draft_id_required", "Choose a draft before starting a voice session.");

    const rows = (await getSql()`
      select id, status, unresolved_issues, measurements, observations, observation_time
      from drafts
      where id = ${draftId} and caregiver_id = ${session.caregiverId}
      limit 1
    `) as Array<{ id: string; status: string; unresolved_issues: unknown; measurements: unknown; observations: unknown; observation_time: string | null }>;
    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
    const issues = Array.isArray(draft.unresolved_issues) ? draft.unresolved_issues as ClarificationIssue[] : [];
    let systemPrompt: string;
    let greeting: string;
    let tool: object;
    let question: string | null = null;
    if (mode === "clarification") {
      if (draft.status !== "NEEDS_CLARIFICATION") {
        throw new ApiError(409, "clarification_not_needed", "This draft has no details waiting for clarification.");
      }
      if (!issues.length) throw new ApiError(409, "no_open_issues", "This draft has no unresolved details.");
      question = clarificationQuestion(issues);
      systemPrompt = clarificationPrompt(issues);
      greeting = `I have one detail to clarify. ${question}`;
      tool = {
        type: "function",
        name: "submit_clarification_answer",
        description: "Save the caregiver's answer to the current clarification question, then continue with the next open question if any.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "The caregiver's answer, transcribed verbatim." } },
          required: ["answer"],
        },
      };
    } else {
      if (draft.status !== "REVIEWABLE" || issues.length) {
        throw new ApiError(409, "draft_not_ready_to_confirm", "Resolve all flagged details before confirming this draft.");
      }
      const measurements = Array.isArray(draft.measurements) ? draft.measurements as Array<{ type?: string; value?: unknown; unit?: string | null }> : [];
      const observations = Array.isArray(draft.observations) ? draft.observations as Array<{ description?: string }> : [];
      const summary = [
        ...measurements.map((measurement) => {
          const value = typeof measurement.value === "object" && measurement.value !== null && "systolic" in measurement.value && "diastolic" in measurement.value
            ? `${measurement.value.systolic} over ${measurement.value.diastolic}`
            : String(measurement.value ?? "");
          return `${measurement.type?.replaceAll("_", " ") ?? "measurement"}: ${value}${measurement.unit ? ` ${measurement.unit}` : ""}`;
        }),
        ...observations.map((observation) => observation.description).filter(Boolean),
        ...(draft.observation_time ? [`observed ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: session.timezone }).format(new Date(draft.observation_time))}`] : []),
      ].join("; ") || "No measurements or observations were extracted";
      systemPrompt = [
        "You are VoiceCare's brief confirmation assistant. Read the draft summary exactly and neutrally; do not diagnose or give medical advice.",
        `Draft summary: ${summary}.`,
        "Ask: 'Is this summary correct? Say yes to confirm, or no to return and edit it.' Do not call the confirmation tool unless the caregiver gives a clear affirmative answer. If they say no or mention any correction, do not confirm; tell them to return to review and edit the draft.",
        "After a clear yes, call confirm_draft with the caregiver's affirmative answer verbatim. Do not say it is confirmed until the tool confirms success.",
      ].join("\n");
      greeting = `Please check this summary: ${summary}. Is it correct? Say yes to confirm, or no to return and edit it.`;
      tool = {
        type: "function",
        name: "confirm_draft",
        description: "Record confirmation only after the caregiver clearly says yes to the summary.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "The caregiver's explicit affirmative answer, verbatim." } },
          required: ["answer"],
        },
      };
    }

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
      mode,
      issue_id: mode === "clarification" ? issues[0]?.id : null,
      question,
      session: {
        system_prompt: systemPrompt,
        greeting,
        input: { format: { encoding: "audio/pcm" }, voice_focus: "near-field" },
        output: { voice: process.env.VOICE_AGENT_VOICE || "alba", format: { encoding: "audio/pcm" } },
        tools: [tool],
      },
    }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
