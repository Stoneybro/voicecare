import { z } from "zod";
import { getSql } from "@/lib/db";
import { loadPersonalExpressions } from "@/lib/expressions";
import { extractTranscriptWithModel } from "@/lib/llm-extraction";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { newId, requireSession } from "@/lib/session";

const finalizeDraftSchema = z.object({
  original_transcript: z.string().trim().min(1).max(30_000),
});

const correctionSchema = z.object({
  measurements: z.array(z.object({
    type: z.enum(["blood_pressure", "blood_glucose", "temperature", "heart_rate", "spo2"]),
    value: z.union([
      z.number().finite().positive(),
      z.string().trim().min(1).max(100),
      z.object({ systolic: z.number().finite().positive(), diastolic: z.number().finite().positive() }),
    ]),
    unit: z.string().trim().max(20).nullable(),
    confidence: z.number().min(0).max(1),
    source_text: z.string().max(2_000),
  }).superRefine((measurement, context) => {
    if (measurement.type === "blood_pressure" && typeof measurement.value !== "object") {
      context.addIssue({ code: "custom", message: "Blood pressure needs systolic and diastolic values.", path: ["value"] });
    }
    if (measurement.type !== "blood_pressure" && typeof measurement.value !== "number") {
      context.addIssue({ code: "custom", message: "This measurement needs a numeric value.", path: ["value"] });
    }
  })).max(30),
  observations: z.array(z.object({
    type: z.enum(["symptom", "pain", "food", "mood", "sleep", "free_text"]),
    description: z.string().trim().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    source_text: z.string().max(2_000),
  })).max(100),
  observation_time: z.string().datetime({ offset: true }).nullable(),
  observation_time_precision: z.enum(["exact", "morning", "afternoon", "evening", "day", "period", "assumed", "unknown"]),
  observation_time_source: z.string().max(200).nullable(),
});

const patchDraftSchema = z.union([finalizeDraftSchema, correctionSchema]);

type DraftRow = {
  id: string;
  patient_id: string;
  revision: number;
  status: string;
  original_transcript: string;
  measurements: unknown;
  observations: unknown;
  observation_time: string | null;
  observation_time_precision: string;
  observation_time_source: string | null;
  unresolved_issues: unknown;
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const patch = await readJson(request, patchDraftSchema);
    const sql = getSql();
    if (!("original_transcript" in patch)) {
      const existingRows = (await sql`
        select id, patient_id, revision, status, unresolved_issues, original_transcript, created_at from drafts
        where id = ${id} and caregiver_id = ${session.caregiverId} limit 1
      `) as Array<{ id: string; patient_id: string; revision: number; status: string; unresolved_issues: unknown; original_transcript: string; created_at: string }>;
      const existing = existingRows[0];
      if (!existing) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
      if (!["NEEDS_CLARIFICATION", "REVIEWABLE"].includes(existing.status)) {
        throw new ApiError(409, "draft_not_editable", "Only an unconfirmed draft can be corrected.");
      }

      const personalExpressions = await loadPersonalExpressions(session.caregiverId, existing.patient_id);
      const baseline = await extractTranscriptWithModel(existing.original_transcript, {
        timeZone: session.timezone,
        now: new Date(existing.created_at),
        patientName: session.patients.find((patient) => patient.id === existing.patient_id)?.display_name,
        personalExpressions,
      });
      const baselineIssues = baseline.unresolved_issues;
      const correctedMeasurements = patch.measurements.map((measurement) => ({
        ...measurement,
        unit: measurement.type === "blood_pressure" ? "mmHg"
          : measurement.type === "heart_rate" ? "bpm"
            : measurement.type === "spo2" ? "%"
              : measurement.unit,
      }));
      const unresolvedIssues = baselineIssues.filter((issue) => {
        if (issue.type === "observation_time_missing") return patch.observation_time === null;
        if (issue.type === "missing_unit") {
          const measurement = correctedMeasurements.find((candidate) => candidate.type === issue.measurement_type);
          return measurement ? !measurement.unit : false;
        }
        if (issue.type === "ambiguous_value") {
          return !correctedMeasurements.some((measurement) => measurement.type === issue.measurement_type);
        }
        return true;
      });
      for (const measurement of correctedMeasurements) {
        if ((measurement.type === "blood_glucose" || measurement.type === "temperature") && !measurement.unit &&
          !unresolvedIssues.some((issue) => issue.id === `missing_unit:${measurement.type}`)) {
          const isGlucose = measurement.type === "blood_glucose";
          unresolvedIssues.push({
            id: `missing_unit:${measurement.type}`,
            type: "missing_unit",
            measurement_type: measurement.type,
            message: isGlucose ? "The glucose value has no unit, so its scale is unclear." : "The temperature has no unit, so the scale is unclear.",
            question: isGlucose ? "Was this glucose value in mg/dL or mmol/L?" : "Was this temperature in Celsius or Fahrenheit?",
            source_text: measurement.source_text,
            blocking: true,
          });
        }
      }
      if (patch.observation_time === null && !unresolvedIssues.some((issue) => issue.id === "observation_time_missing")) {
        unresolvedIssues.push({
          id: "observation_time_missing",
          type: "observation_time_missing",
          message: "No observation time was stated.",
          question: "When was this update observed? For example, today or yesterday?",
          source_text: existing.original_transcript,
          blocking: true,
        });
      }
      for (const measurement of baseline.measurements) {
        if (correctedMeasurements.some((candidate) => candidate.type === measurement.type) ||
          unresolvedIssues.some((issue) => issue.measurement_type === measurement.type)) continue;
        unresolvedIssues.push({
          id: `ambiguous_value:${measurement.type}`,
          type: "ambiguous_value",
          measurement_type: measurement.type,
          message: `The ${measurement.type.replaceAll("_", " ")} reading needs a value.`,
          question: `What was the ${measurement.type.replaceAll("_", " ")} reading?`,
          source_text: measurement.source_text,
          blocking: true,
        });
      }
      const status = unresolvedIssues.length ? "NEEDS_CLARIFICATION" : "REVIEWABLE";
      const revisionId = newId("rev");
      const rows = (await sql`
        with updated as (
          update drafts
          set revision = revision + 1,
              status = ${status},
              measurements = ${JSON.stringify(correctedMeasurements)}::jsonb,
              observations = ${JSON.stringify(patch.observations)}::jsonb,
              observation_time = ${patch.observation_time},
              observation_time_precision = ${patch.observation_time_precision},
              observation_time_source = ${patch.observation_time_source},
              unresolved_issues = ${JSON.stringify(unresolvedIssues)}::jsonb,
              clarification_log = clarification_log || ${JSON.stringify(baseline.expression_candidates.map((candidate) => ({ resolved: true, expression_candidate: candidate })))}::jsonb,
              confirmed_revision = null,
              confirmation_method = null,
              confirmed_at = null,
              updated_at = now()
          where id = ${id} and caregiver_id = ${session.caregiverId}
            and revision = ${existing.revision} and status in ('NEEDS_CLARIFICATION','REVIEWABLE')
          returning id, patient_id, revision, status, original_transcript, measurements, observations,
            observation_time, observation_time_precision, observation_time_source, unresolved_issues
        ), logged as (
          insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
          select ${revisionId}, id, revision, status,
            jsonb_build_object(
              'revision', revision, 'status', status, 'patient_id', patient_id,
              'original_transcript', original_transcript, 'measurements', measurements,
              'observations', observations, 'observation_time', observation_time,
              'observation_time_precision', observation_time_precision,
              'observation_time_source', observation_time_source,
              'unresolved_issues', unresolved_issues
            ), 'caregiver_correction'
          from updated returning draft_id
        )
        select * from updated
      `) as DraftRow[];
      if (!rows[0]) throw new ApiError(409, "draft_changed", "This draft changed while the correction was being saved. Refresh and try again.");
      return jsonOk({
        draft_id: rows[0].id, status: rows[0].status, revision: rows[0].revision,
        measurements: rows[0].measurements, observations: rows[0].observations,
        observation_time: rows[0].observation_time,
        observation_time_precision: rows[0].observation_time_precision,
        observation_time_source: rows[0].observation_time_source,
        unresolved_issues: rows[0].unresolved_issues,
      });
    }

    const transcript = patch.original_transcript;
    const revisionId = newId("rev");
    const ownerRows = await sql`select patient_id, created_at from drafts where id = ${id} and caregiver_id = ${session.caregiverId} limit 1` as Array<{ patient_id: string; created_at: string }>;
    if (!ownerRows[0]) throw new ApiError(404, "draft_not_found", "That recording could not be found in this demo workspace.");
    const personalExpressions = await loadPersonalExpressions(session.caregiverId, ownerRows[0].patient_id);
    const extraction = await extractTranscriptWithModel(transcript, {
      timeZone: session.timezone,
      now: new Date(ownerRows[0].created_at),
      patientName: session.patients.find((patient) => patient.id === ownerRows[0].patient_id)?.display_name,
      personalExpressions,
    });
    const status = extraction.unresolved_issues.length > 0 ? "NEEDS_CLARIFICATION" : "REVIEWABLE";

    // Update and append the immutable revision snapshot in one statement. The owner and state
    // predicates make an unowned or already-finalized draft impossible to mutate through this API.
    const rows = (await sql`
      with updated as (
        update drafts
        set original_transcript = ${transcript},
            status = ${status},
            revision = revision + 1,
            measurements = ${JSON.stringify(extraction.measurements)}::jsonb,
            observations = ${JSON.stringify(extraction.observations)}::jsonb,
            observation_time = ${extraction.observation_time},
            observation_time_precision = ${extraction.observation_time_precision},
            observation_time_source = ${extraction.observation_time_source},
            unresolved_issues = ${JSON.stringify(extraction.unresolved_issues)}::jsonb,
            clarification_log = clarification_log || ${JSON.stringify(extraction.expression_candidates.map((candidate) => ({ resolved: true, expression_candidate: candidate })))}::jsonb,
            updated_at = now()
        where id = ${id}
          and caregiver_id = ${session.caregiverId}
          and status = 'CAPTURING'
        returning id, patient_id, revision, status, original_transcript, measurements, observations,
          observation_time, observation_time_precision, observation_time_source, unresolved_issues
      ), logged as (
        insert into draft_revisions (id, draft_id, revision, status, snapshot, reason)
        select ${revisionId}, id, revision, status,
          jsonb_build_object(
            'revision', revision,
            'status', status,
            'patient_id', patient_id,
            'original_transcript', original_transcript,
            'measurements', measurements,
            'observations', observations,
            'observation_time', observation_time,
            'observation_time_precision', observation_time_precision,
            'observation_time_source', observation_time_source,
            'unresolved_issues', unresolved_issues
          ),
          'transcript_captured'
        from updated
        returning draft_id
      )
      select id, patient_id, revision, status, original_transcript, measurements, observations,
        observation_time, observation_time_precision, observation_time_source, unresolved_issues
      from updated
    `) as DraftRow[];

    if (rows[0]) {
      return jsonOk({
        draft_id: rows[0].id,
        status: rows[0].status,
        revision: rows[0].revision,
        measurements: rows[0].measurements,
        observations: rows[0].observations,
        observation_time: rows[0].observation_time,
        observation_time_precision: rows[0].observation_time_precision,
        observation_time_source: rows[0].observation_time_source,
        unresolved_issues: rows[0].unresolved_issues,
      });
    }

    const existing = (await sql`
      select id, revision, status, original_transcript, measurements, observations,
        observation_time, observation_time_precision, observation_time_source, unresolved_issues
      from drafts
      where id = ${id} and caregiver_id = ${session.caregiverId}
      limit 1
    `) as DraftRow[];

    if (!existing[0]) {
      throw new ApiError(404, "draft_not_found", "That recording could not be found in this demo workspace.");
    }
    if (
      ["NEEDS_CLARIFICATION", "REVIEWABLE"].includes(existing[0].status) &&
      existing[0].original_transcript === transcript
    ) {
      return jsonOk({ draft_id: id, ...existing[0] });
    }
    throw new ApiError(409, "draft_not_capturing", "This recording has already been finalized.");
  });
}

// Stage 3 review loads only a draft owned by the current demo session.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const rows = (await getSql()`
      select d.id, d.patient_id, p.display_name as patient_name, d.revision, d.status,
        d.original_transcript, d.measurements, d.observations, d.observation_time,
        d.observation_time_precision, d.observation_time_source, d.unresolved_issues,
        d.confirmation_method, d.confirmed_at, d.confirmed_revision, d.clarification_log,
        coalesce((
          select jsonb_agg(lower(e.phrase)) from personal_expressions e
          where e.caregiver_id = d.caregiver_id and e.deleted_at is null
            and (e.patient_id = d.patient_id or e.patient_id is null)
        ), '[]'::jsonb) as remembered_phrases
      from drafts d
      join patients p on p.id = d.patient_id and p.caregiver_id = d.caregiver_id
      where d.id = ${id} and d.caregiver_id = ${session.caregiverId}
      limit 1
    `) as Array<{
      id: string;
      patient_id: string;
      patient_name: string;
      revision: number;
      status: string;
      original_transcript: string;
      measurements: unknown;
      observations: unknown;
      observation_time: string | null;
      observation_time_precision: string;
      observation_time_source: string | null;
      unresolved_issues: unknown;
      confirmation_method: string | null;
      confirmed_at: string | null;
      confirmed_revision: number | null;
      clarification_log: unknown;
      remembered_phrases: unknown;
    }>;

    const draft = rows[0];
    if (!draft) throw new ApiError(404, "draft_not_found", "That draft could not be found in this demo workspace.");
    if (!["NEEDS_CLARIFICATION", "REVIEWABLE", "CONFIRMED"].includes(draft.status)) {
      throw new ApiError(409, "draft_not_ready", "This draft is not ready for review yet.");
    }
    const log = Array.isArray(draft.clarification_log)
      ? draft.clarification_log as Array<{
        resolved?: boolean;
        source?: string;
        expression_candidate_id?: string;
        expression_candidate?: { candidate_id?: string; phrase?: string; source_text?: string };
        memory_suggestion?: { suggestion_id?: string; phrase?: string; measurement_type?: string; unit?: string | null };
      }>
      : [];
    const suggestions = new Map<string, { suggestion_id: string; phrase: string; measurement_type: string; unit: string | null; patient_id: string; patient_name: string }>();
    const candidates = new Map<string, { candidate_id: string; phrase: string; source_text: string; patient_id: string; patient_name: string }>();
    const resolvedCandidateIds = new Set(log.map((entry) => entry.expression_candidate_id).filter((id): id is string => typeof id === "string"));
    const rememberedPhrases = new Set(Array.isArray(draft.remembered_phrases)
      ? draft.remembered_phrases.filter((phrase): phrase is string => typeof phrase === "string")
      : []);
    for (const entry of log) {
      const suggestion = entry.resolved && entry.source !== "llm_expression_suggestion" ? entry.memory_suggestion : null;
      if (suggestion && typeof suggestion.suggestion_id === "string" && typeof suggestion.phrase === "string" &&
        typeof suggestion.measurement_type === "string" && !rememberedPhrases.has(suggestion.phrase.toLocaleLowerCase())) {
        suggestions.set(suggestion.suggestion_id, {
          suggestion_id: suggestion.suggestion_id,
          phrase: suggestion.phrase,
          measurement_type: suggestion.measurement_type,
          unit: typeof suggestion.unit === "string" ? suggestion.unit : null,
          patient_id: draft.patient_id,
          patient_name: draft.patient_name,
        });
      }
      const candidate = entry.resolved ? entry.expression_candidate : null;
      if (candidate && typeof candidate.candidate_id === "string" && typeof candidate.phrase === "string" &&
        typeof candidate.source_text === "string" && !resolvedCandidateIds.has(candidate.candidate_id)) {
        candidates.set(candidate.candidate_id, { ...candidate as { candidate_id: string; phrase: string; source_text: string }, patient_id: draft.patient_id, patient_name: draft.patient_name });
      }
    }
    return jsonOk({ draft, expression_candidates: [...candidates.values()], expression_suggestions: [...suggestions.values()], ai_extraction_available: Boolean(process.env.GEMINI_API_KEY) });
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const deleted = await getSql()`
      delete from drafts
      where id = ${id} and caregiver_id = ${session.caregiverId} and status = 'CAPTURING'
      returning id
    `;
    if (deleted.length === 0) {
      throw new ApiError(404, "capturing_draft_not_found", "The unfinished recording could not be found.");
    }
    return jsonOk({ draft_id: id, deleted: true });
  });
}
