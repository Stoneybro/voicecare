import { z } from "zod";
import { getSql } from "@/lib/db";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { loadSuggestionForDraft } from "@/lib/expressions";
import { newId, requireSession } from "@/lib/session";

const rememberSchema = z.object({
  draft_id: z.string().min(1).max(100),
  suggestion_id: z.string().regex(/^[a-f0-9]{24}$/),
});

export async function GET(): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const rows = await getSql()`
      select e.id, e.patient_id, p.display_name as patient_name, e.phrase,
        e.normalized_meaning, e.context_constraints, e.confirmed_at, e.created_at
      from personal_expressions e
      left join patients p on p.id = e.patient_id and p.caregiver_id = e.caregiver_id
      where e.caregiver_id = ${session.caregiverId} and e.deleted_at is null
      order by e.confirmed_at desc, lower(e.phrase)
    `;
    return jsonOk({ expressions: rows }, { headers: { "Cache-Control": "no-store, private" } });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, rememberSchema);
    const suggestion = await loadSuggestionForDraft(body.draft_id, session.caregiverId, body.suggestion_id);
    if (!suggestion) throw new ApiError(409, "expression_confirmation_missing", "That phrase is no longer available to remember. Repeat the clarification to offer it again.");

    const sql = getSql();
    await sql`
      insert into personal_expressions
        (id, caregiver_id, patient_id, phrase, normalized_meaning, context_constraints, confirmed_at)
      values (
        ${newId("expr")}, ${session.caregiverId}, ${suggestion.patient_id}, ${suggestion.phrase},
        ${JSON.stringify({ measurement_type: suggestion.measurement_type, unit: suggestion.unit })}::jsonb,
        ${JSON.stringify({ source: "explicit_caregiver_confirmation" })}::jsonb, now()
      )
      on conflict (caregiver_id, (coalesce(patient_id, '')), lower(phrase)) where deleted_at is null
      do update set normalized_meaning = excluded.normalized_meaning,
        context_constraints = excluded.context_constraints, confirmed_at = now(), updated_at = now()
    `;
    const rows = await sql`
      select id, patient_id, phrase, normalized_meaning, confirmed_at
      from personal_expressions
      where caregiver_id = ${session.caregiverId} and patient_id = ${suggestion.patient_id}
        and lower(phrase) = lower(${suggestion.phrase}) and deleted_at is null
      limit 1
    `;
    return jsonOk({ expression: rows[0] }, { status: 201, headers: { "Cache-Control": "no-store, private" } });
  });
}
