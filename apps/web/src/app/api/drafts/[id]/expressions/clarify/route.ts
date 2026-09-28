import { z } from "zod";
import { getSql } from "@/lib/db";
import { resolveExpressionSuggestion, type ExpressionCandidate } from "@/lib/expressions";
import { resolveExpressionMeaningFromAnswer } from "@/lib/llm-extraction";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { requireSession } from "@/lib/session";

const answerSchema = z.object({
  candidate_id: z.string().regex(/^[a-f0-9]{24}$/),
  answer: z.string().trim().min(1).max(2_000),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const body = await readJson(request, answerSchema);
    const rows = await getSql()`
      select d.patient_id, p.display_name as patient_name, d.clarification_log
      from drafts d join patients p on p.id = d.patient_id and p.caregiver_id = d.caregiver_id
      where d.id = ${id} and d.caregiver_id = ${session.caregiverId}
      limit 1
    ` as Array<{ patient_id: string; patient_name: string; clarification_log: unknown }>;
    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");

    const entries = Array.isArray(draft.clarification_log)
      ? draft.clarification_log as Array<{ expression_candidate?: ExpressionCandidate; expression_candidate_id?: string }>
      : [];
    const candidate = entries.map((entry) => entry.expression_candidate)
      .find((entry) => entry?.candidate_id === body.candidate_id);
    if (!candidate) throw new ApiError(409, "expression_candidate_missing", "That phrase is no longer available to clarify.");

    const suggestion = resolveExpressionSuggestion(candidate.phrase, body.answer) ??
      await resolveExpressionMeaningFromAnswer(candidate.phrase, body.answer);
    if (!suggestion) {
      return jsonOk({ resolved: false, message: "I couldn't identify which measurement you mean. Choose one from the list instead." });
    }

    await getSql()`
      update drafts
      set clarification_log = clarification_log || ${JSON.stringify([{
        resolved: true,
        source: "caregiver_defined_expression",
        expression_candidate_id: candidate.candidate_id,
        memory_suggestion: suggestion,
      }])}::jsonb,
      updated_at = now()
      where id = ${id} and caregiver_id = ${session.caregiverId}
    `;
    return jsonOk({
      resolved: true,
      expression_suggestion: { ...suggestion, patient_id: draft.patient_id, patient_name: draft.patient_name },
    }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
