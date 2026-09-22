// Server-side handling for the AssemblyAI voice agent tools (spec/04 "Structured extraction
// contract", spec/05 "AssemblyAI integration").
//
// The model may propose an interpretation; this module validates the arguments against the same
// shared schema the tools were generated from, applies them through the draft lifecycle in
// drafts.ts, and returns a compact result the agent can speak. Tool calls never create confirmed
// reports directly: they update a server-side draft, and only the backend can confirm and save.

import {
  askCaregiverArgsSchema,
  confirmPatientUnitArgsSchema,
  expressionPermissionQuestion,
  extractCareReport,
  finishDraftArgsSchema,
  formatValidationIssues,
  isUnitForType,
  rememberExpressionArgsSchema,
  updateDraftArgsSchema,
  type AgentToolName,
  type DraftRecord,
} from "@voicecare/shared";
import type { z } from "zod";
import { applyDraftChange, findDraftRow, loadDraft, makeClarification, recordFromRow } from "./drafts";
import { getSql } from "./db";
import { createExpression, listKnownExpressions } from "./expressions";
import { ApiError } from "./http";
import { patientPreferredUnits, sessionPatient, type DemoSession } from "./session";

export type ToolResult = {
  ok: true;
  revision: number;
  status: DraftRecord["status"];
  blocking_questions: string[];
  readback: string;
  unresolved_statement: string | null;
  note?: string;
};

function parseToolArgs<T>(schema: z.ZodType<T>, args: unknown, tool: string): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    // Every problem at once: the agent fixes all fields in one retry instead of
    // discovering them one 400 at a time and stalling the conversation. Logged server-side
    // (visible in the dev terminal) so a recurring rejection can be traced to the exact args.
    const detail = formatValidationIssues(parsed.error);
    console.error(`[voicecare] tool arguments rejected: ${tool}: ${detail} args=${JSON.stringify(args).slice(0, 500)}`);
    throw new ApiError(
      400,
      "invalid_tool_arguments",
      `${tool}: ${detail}. Fix every field and call again with the same expected_revision.`,
    );
  }
  return parsed.data;
}

function toResult(draft: DraftRecord, note?: string): ToolResult {
  return {
    ok: true,
    revision: draft.revision,
    status: draft.status,
    blocking_questions: draft.unresolved_issues.filter((issue) => issue.blocking).map((issue) => issue.question),
    readback: draft.readback,
    unresolved_statement: draft.unresolved_statement,
    ...(note ? { note } : {}),
  };
}

// Patient identity comes from the server session and the draft URL, never from the model:
// the voice agent is never told internal ids, so any patient identifier it sends would be
// hallucinated. findDraftRow already scopes the draft to this session's caregiver.
async function draftContext(session: DemoSession, draftId: string) {
  const row = await findDraftRow(session, draftId);
  const record = recordFromRow(row, session.timezone);
  const patient = await sessionPatient(session, row.patient_id);
  const units = patientPreferredUnits(patient);
  const expressions = await listKnownExpressions(session.caregiverId, row.patient_id);
  return { row, record, patient, units, expressions };
}

async function handleUpdateDraft(
  session: DemoSession,
  draftId: string,
  args: unknown,
): Promise<ToolResult> {
  const input = parseToolArgs(updateDraftArgsSchema, args, "update_draft");
  const context = await draftContext(session, draftId);
  const draft = await applyDraftChange(session, {
    draftId,
    expectedRevision: input.expected_revision,
    reason: "agent_update",
    patch: {
      observation_time: input.observation_time,
      observation_time_status: input.observation_time_status,
      observation_time_source_text: input.observation_time_source_text,
      measurements: input.measurements,
      observations: input.observations,
      remove_measurement_ids: input.remove_measurement_ids,
      remove_observation_ids: input.remove_observation_ids,
      transcript: input.transcript,
    },
    patientUnits: context.units,
    expressions: context.expressions,
  });
  return toResult(draft);
}

async function handleAskCaregiver(
  session: DemoSession,
  draftId: string,
  args: unknown,
): Promise<ToolResult> {
  const input = parseToolArgs(askCaregiverArgsSchema, args, "ask_caregiver");
  const context = await draftContext(session, draftId);
  if (input.kind === "expression" && !input.phrase) {
    throw new ApiError(400, "invalid_tool_arguments", "ask_caregiver: phrase is required when kind is 'expression'.");
  }
  const question =
    input.kind === "expression" && input.phrase && input.measurement_type
      ? expressionPermissionQuestion(input.phrase, input.measurement_type, input.unit ?? null)
      : input.question;
  const clarification = makeClarification({
    kind: input.kind,
    question,
    options: input.options,
    targetId: input.target_id,
    phrase: input.phrase,
    measurementType: input.measurement_type,
    unit: input.unit,
    patientSpecific: input.patient_specific,
    source: "agent",
    now: new Date(),
  });
  const draft = await applyDraftChange(session, {
    draftId,
    expectedRevision: input.expected_revision,
    reason: "agent_update",
    patch: {},
    patientUnits: context.units,
    expressions: context.expressions,
    clarification,
  });
  return toResult(draft);
}

async function handleRememberExpression(
  session: DemoSession,
  draftId: string,
  args: unknown,
): Promise<ToolResult> {
  const input = parseToolArgs(rememberExpressionArgsSchema, args, "remember_expression");
  const row = await findDraftRow(session, draftId);
  const record = recordFromRow(row, session.timezone);
  const phrase = input.phrase.trim().toLowerCase();

  const openIssue = record.unresolved_issues.find(
    (issue) => issue.code === "expression_permission" && issue.phrase?.trim().toLowerCase() === phrase,
  );
  const openClarification = record.clarifications.find(
    (entry) => entry.kind === "expression" && !entry.answered_at && entry.phrase?.trim().toLowerCase() === phrase,
  );

  let note: string | undefined;
  if (input.confirmed_by_caregiver) {
    try {
      await createExpression(session.caregiverId, row.patient_id, {
        phrase: input.phrase.trim(),
        measurement_type: input.measurement_type,
        unit: input.unit ?? null,
        patient_specific: input.patient_specific,
        approved: true,
        approved_via: "voice",
      });
      note = `Remembered "${input.phrase.trim()}" for future reports.`;
    } catch (error) {
      if (error instanceof ApiError && error.code === "expression_exists") {
        note = `"${input.phrase.trim()}" was already remembered.`;
      } else {
        throw error;
      }
    }
  } else {
    note = `The caregiver declined, so "${input.phrase.trim()}" was not remembered.`;
  }

  const context = await draftContext(session, draftId);
  const draft = await applyDraftChange(session, {
    draftId,
    expectedRevision: input.expected_revision,
    reason: "clarification_answer",
    patch: {
      ...(openIssue ? { resolve_issue_ids: [openIssue.id] } : {}),
      ...(openClarification
        ? { answer_clarification_id: openClarification.id, answer_text: input.confirmed_by_caregiver ? "yes, remember it" : "no, do not remember it" }
        : {}),
    },
    patientUnits: context.units,
    expressions: await listKnownExpressions(session.caregiverId, row.patient_id),
  });
  return toResult(draft, note);
}

export async function setPatientUnit(
  caregiverId: string,
  patientId: string,
  type: string,
  unit: string,
): Promise<void> {
  await getSql()`
    update patients
    set preferred_units = coalesce(preferred_units, '{}'::jsonb) || ${JSON.stringify({ [type]: unit })}::jsonb
    where id = ${patientId} and caregiver_id = ${caregiverId}
  `;
}

async function handleConfirmPatientUnit(
  session: DemoSession,
  draftId: string,
  args: unknown,
): Promise<ToolResult> {
  const input = parseToolArgs(confirmPatientUnitArgsSchema, args, "confirm_patient_unit");
  if (!input.confirmed_by_caregiver) {
    throw new ApiError(400, "unit_not_confirmed", "The caregiver has not confirmed the unit yet. Ask them first.");
  }
  if (!isUnitForType(input.measurement_type, input.unit)) {
    throw new ApiError(400, "unsupported_unit", `"${input.unit}" is not a supported unit for this measurement.`);
  }
  const row = await findDraftRow(session, draftId);
  const record = recordFromRow(row, session.timezone);

  if (input.remember_for_future_reports) {
    await setPatientUnit(session.caregiverId, row.patient_id, input.measurement_type, input.unit);
  }

  // Apply the confirmed unit to the measurement it belongs to, keeping the spoken values.
  const target = input.measurement_id
    ? record.measurements.find((item) => item.id === input.measurement_id)
    : record.measurements.filter((item) => item.type === input.measurement_type)[0];
  if (!target && input.measurement_id) {
    throw new ApiError(404, "measurement_not_found", "That measurement is no longer on the draft.");
  }

  const context = await draftContext(session, draftId);
  const units = { ...context.units };
  if (input.remember_for_future_reports) units[input.measurement_type] = input.unit;
  const draft = await applyDraftChange(session, {
    draftId,
    expectedRevision: input.expected_revision,
    reason: "clarification_answer",
    patch: target
      ? {
          measurements: [
            {
              id: target.id,
              type: target.type,
              systolic: target.systolic ?? undefined,
              diastolic: target.diastolic ?? undefined,
              value: target.value ?? undefined,
              unit: input.unit,
              source_text: target.source_text,
            },
          ],
        }
      : {},
    patientUnits: units,
    expressions: context.expressions,
  });
  return toResult(
    draft,
    input.remember_for_future_reports
      ? `The unit ${input.unit} now applies to this report and future reports.`
      : `The unit ${input.unit} applies to this report only.`,
  );
}

async function handleFinishDraft(
  session: DemoSession,
  draftId: string,
  args: unknown,
): Promise<ToolResult & { can_save: boolean; next_step: string }> {
  parseToolArgs(finishDraftArgsSchema, args, "finish_draft");
  const draft = await loadDraft(session, draftId);
  const canSave = draft.status === "REVIEWABLE" && draft.unresolved_issues.filter((issue) => issue.blocking).length === 0;
  return {
    ...toResult(draft),
    can_save: canSave,
    next_step: canSave
      ? "Read the readback sentence word for word, then wait for the caregiver to confirm or correct it in the app."
      : "Speak the first blocking question and wait for the answer.",
  };
}

export async function handleAgentTool(
  session: DemoSession,
  draftId: string,
  tool: string,
  args: unknown,
): Promise<ToolResult> {
  const name = tool as AgentToolName;
  switch (name) {
    case "update_draft":
      return handleUpdateDraft(session, draftId, args);
    case "ask_caregiver":
      return handleAskCaregiver(session, draftId, args);
    case "remember_expression":
      return handleRememberExpression(session, draftId, args);
    case "confirm_patient_unit":
      return handleConfirmPatientUnit(session, draftId, args);
    case "finish_draft":
      return handleFinishDraft(session, draftId, args);
    default:
      throw new ApiError(400, "unknown_tool", `The tool "${tool}" is not part of this session.`);
  }
}

// Typed-observation fallback (FR-015): the same sentence goes through rule-based extraction
// locally, then through the exact same backend resolution rules, so typed input cannot skip
// validation. Used when microphone capture is unavailable.
export async function submitTypedObservation(
  session: DemoSession,
  draftId: string,
  input: { expectedRevision: number; text: string },
): Promise<DraftRecord> {
  const row = await findDraftRow(session, draftId);
  const record = recordFromRow(row, session.timezone);
  const text = input.text.trim();
  if (!text) {
    throw new ApiError(400, "empty_observation", "Type what you observed before continuing.");
  }
  const context = await draftContext(session, draftId);
  const extracted = extractCareReport(text, {
    now: new Date(),
    timeZone: session.timezone,
    patientUnits: context.units,
    expressions: context.expressions,
  });
  const transcript = record.transcript ? `${record.transcript} ${extracted.transcript}` : extracted.transcript;
  return applyDraftChange(session, {
    draftId,
    expectedRevision: input.expectedRevision,
    reason: "caregiver_correction",
    patch: {
      transcript,
      observation_time: extracted.reportTime.observed_at,
      observation_time_status: extracted.reportTime.status,
      observation_time_source_text: extracted.reportTime.source_text,
      measurements: extracted.measurements,
      observations: extracted.observations,
    },
    patientUnits: context.units,
    expressions: context.expressions,
  });
}
