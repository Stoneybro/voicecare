import { z } from "zod";
import { amendTranscriptForClarification, clarificationTip, type ClarificationIssue } from "@/lib/clarification";
import { getSql } from "@/lib/db";
import { detectExpressionSuggestion, loadPersonalExpressions } from "@/lib/expressions";
import { extractTranscriptWithModel } from "@/lib/llm-extraction";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { newId, requireSession } from "@/lib/session";

const clarifySchema = z.object({
  issue_id: z.string().min(1).max(100),
  answer: z.string().trim().min(1).max(2_000),
  session_id: z.string().max(200).optional(),
});

type DraftRow = {
  id: string;
  patient_id: string;
  revision: number;
  status: string;
  original_transcript: string;
  unresolved_issues: unknown;
  created_at: string;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const { issue_id: issueId, answer, session_id: sessionId } = await readJson(request, clarifySchema);
    const sql = getSql();
    const rows = (await sql`
      select id, patient_id, revision, status, original_transcript, unresolved_issues, created_at
      from drafts where id = ${id} and caregiver_id = ${session.caregiverId} limit 1
    `) as DraftRow[];
    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
    if (draft.status !== "NEEDS_CLARIFICATION") {
      throw new ApiError(409, "clarification_not_needed", "This draft has no details waiting for clarification.");
    }
    const issues = Array.isArray(draft.unresolved_issues) ? draft.unresolved_issues as ClarificationIssue[] : [];
    const issue = issues.find((entry) => entry.id === issueId);
    if (!issue) throw new ApiError(409, "issue_already_resolved", "That detail is no longer waiting for clarification. Refresh the review.");

    const amendedTranscript = amendTranscriptForClarification(draft.original_transcript, issue, answer);
    const personalExpressions = await loadPersonalExpressions(session.caregiverId, draft.patient_id);
    const extraction = await extractTranscriptWithModel(amendedTranscript, {
      timeZone: session.timezone,
      now: new Date(draft.created_at),
      patientName: session.patients.find((patient) => patient.id === draft.patient_id)?.display_name,
      personalExpressions,
    });
    const nextIssues = extraction.unresolved_issues;
    const nextStatus = nextIssues.length ? "NEEDS_CLARIFICATION" : "REVIEWABLE";
    const revisionId = newId("rev");
    const clarificationEntry: { [key: string]: unknown; resolved: boolean } = {
      issue_id: issue.id,
      issue_type: issue.type,
      question: issue.question,
      answer,
      recorded_at: new Date().toISOString(),
      resolved: !nextIssues.some((entry) => entry.id === issue.id),
    };
    const nextIssue = clarificationEntry.resolved
      ? nextIssues[0]
      : nextIssues.find((entry) => entry.id === issue.id) ?? nextIssues[0];
    const memorySuggestion = detectExpressionSuggestion(`${draft.original_transcript}\n${answer}`);
    if (memorySuggestion && clarificationEntry.resolved) clarificationEntry["memory_suggestion"] = memorySuggestion;
    const patient = session.patients.find((entry) => entry.id === draft.patient_id);

    const updated = (await sql`
      with changed as (
        update drafts
        set original_transcript = ${amendedTranscript},
            revision = revision + 1,
            status = ${nextStatus},
            measurements = ${JSON.stringify(extraction.measurements)}::jsonb,
            observations = ${JSON.stringify(extraction.observations)}::jsonb,
            observation_time = ${extraction.observation_time},
            observation_time_precision = ${extraction.observation_time_precision},
            observation_time_source = ${extraction.observation_time_source},
            unresolved_issues = ${JSON.stringify(nextIssues)}::jsonb,
            clarification_log = clarification_log || ${JSON.stringify([
              ...extraction.expression_candidates.map((candidate) => ({ resolved: true, expression_candidate: candidate })),
              clarificationEntry,
            ])}::jsonb,
            session_id = coalesce(${sessionId ?? null}, session_id),
            updated_at = now()
        where id = ${id} and caregiver_id = ${session.caregiverId}
          and revision = ${draft.revision} and status = 'NEEDS_CLARIFICATION'
        returning id, revision, status, original_transcript, measurements, observations,
          observation_time, observation_time_precision, observation_time_source,
          unresolved_issues, clarification_log
      ), logged as (
        insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
        select ${revisionId}, id, revision, status,
          jsonb_build_object(
            'revision', revision, 'status', status, 'original_transcript', original_transcript,
            'measurements', measurements, 'observations', observations,
            'observation_time', observation_time, 'observation_time_precision', observation_time_precision,
            'observation_time_source', observation_time_source, 'unresolved_issues', unresolved_issues,
            'clarification_log', clarification_log
          ), 'clarification_answer'
        from changed returning draft_id
      )
      select * from changed
    `) as Array<DraftRow & {
      measurements: unknown;
      observations: unknown;
      observation_time: string | null;
      observation_time_precision: string;
      observation_time_source: string | null;
      clarification_log: unknown;
    }>;
    if (!updated[0]) throw new ApiError(409, "draft_changed", "This draft changed while the answer was being saved. Refresh and try again.");

    return jsonOk({
      draft_id: updated[0].id,
      revision: updated[0].revision,
      status: updated[0].status,
      issue_resolved: clarificationEntry.resolved,
      next_issue_id: nextIssue?.id ?? null,
      next_question: nextIssue?.question ?? null,
      next_tip: clarificationTip(nextIssue),
      unresolved_issues: nextIssues,
      measurements: updated[0].measurements,
      observations: updated[0].observations,
      observation_time: updated[0].observation_time,
      observation_time_precision: updated[0].observation_time_precision,
      observation_time_source: updated[0].observation_time_source,
      clarification_log: updated[0].clarification_log,
      expression_suggestion: memorySuggestion && clarificationEntry.resolved && patient
        ? { ...memorySuggestion, patient_id: draft.patient_id, patient_name: patient.display_name }
        : null,
    }, { headers: { "Cache-Control": "no-store, private" } });
  });
}
