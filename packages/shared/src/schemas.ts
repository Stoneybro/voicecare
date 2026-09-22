// Zod schemas for the VoiceCare draft contract (spec/05 "Shared structured-data contract").
//
// Three layers, all in this package so the agent tools, the backend, the browser, and the tests
// cannot drift apart:
//   1. stored*  schemas - the normalized shapes persisted in PostgreSQL jsonb.
//   2. *Input   schemas - the permissive shapes the voice agent proposes through tool calls.
//   3. tool/API schemas - the request payloads the backend accepts.
//
// The JSON Schema handed to the AssemblyAI voice agent is derived from `updateDraftArgsSchema`
// with `z.toJSONSchema` (see tool-schema.ts), so the tool definition is generated, not retyped.

import { z } from "zod";
import {
  CLARIFICATION_KINDS,
  CONFIRMATION_METHODS,
  DRAFT_REVISION_REASONS,
  DRAFT_STATUSES,
  ISSUE_CODES,
  MEASUREMENT_TYPES,
  OBSERVATION_CATEGORIES,
  RESOLUTION_STATUSES,
  TIME_PRECISIONS,
  TIME_STATUSES,
  UNIT_SOURCES,
} from "./vocab.ts";

export const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO 8601 date-time");

export const measurementTypeSchema = z.enum(MEASUREMENT_TYPES);
export const observationCategorySchema = z.enum(OBSERVATION_CATEGORIES);
export const timeStatusSchema = z.enum(TIME_STATUSES);
export const timePrecisionSchema = z.enum(TIME_PRECISIONS);
export const resolutionStatusSchema = z.enum(RESOLUTION_STATUSES);
export const unitSourceSchema = z.enum(UNIT_SOURCES);
export const issueCodeSchema = z.enum(ISSUE_CODES);
export const clarificationKindSchema = z.enum(CLARIFICATION_KINDS);
export const confirmationMethodSchema = z.enum(CONFIRMATION_METHODS);
export const revisionReasonSchema = z.enum(DRAFT_REVISION_REASONS);

export const finiteNumberSchema = z.coerce.number().finite();

// ---------------------------------------------------------------------------------------------
// Stored (normalized) shapes - exactly what the backend persists in jsonb.
// ---------------------------------------------------------------------------------------------

export const measurementSchema = z.object({
  id: z.string(),
  type: measurementTypeSchema,
  systolic: z.number().finite().nullable(),
  diastolic: z.number().finite().nullable(),
  value: z.number().finite().nullable(),
  unit: z.string().nullable(),
  unit_source: unitSourceSchema.nullable(),
  observed_at: isoDateTimeSchema.nullable(),
  time_precision: timePrecisionSchema,
  time_source_text: z.string().nullable(),
  time_status: timeStatusSchema,
  source_text: z.string(),
  resolution_status: resolutionStatusSchema,
  ambiguity_note: z.string().nullable(),
  clarification_question: z.string().nullable(),
  warning: z.string().nullable(),
  expression_id: z.string().nullable(),
  expression_phrase: z.string().nullable(),
});
export type Measurement = z.infer<typeof measurementSchema>;

export const observationSchema = z.object({
  id: z.string(),
  category: observationCategorySchema,
  text: z.string(),
  body_location: z.string().nullable(),
  negated: z.boolean(),
  observed_at: isoDateTimeSchema.nullable(),
  time_precision: timePrecisionSchema,
  time_source_text: z.string().nullable(),
  time_status: timeStatusSchema,
  source_text: z.string(),
  resolution_status: resolutionStatusSchema,
  ambiguity_note: z.string().nullable(),
  clarification_question: z.string().nullable(),
  warning: z.string().nullable(),
});
export type Observation = z.infer<typeof observationSchema>;

export const observationTimeSchema = z.object({
  observed_at: isoDateTimeSchema.nullable(),
  precision: timePrecisionSchema,
  status: timeStatusSchema,
  source_text: z.string().nullable(),
});
export type ObservationTime = z.infer<typeof observationTimeSchema>;


export const draftIssueSchema = z.object({
  id: z.string(),
  code: issueCodeSchema,
  target: z.enum(["measurement", "observation", "report"]),
  target_id: z.string().nullable(),
  question: z.string(),
  options: z.array(z.string()),
  blocking: z.boolean(),
  source: z.enum(["backend", "agent"]),
  created_at: isoDateTimeSchema,
  // Expression permission questions carry the proposed association so the browser can render the
  // same choice the agent offers by voice (FR-050).
  phrase: z.string().nullable(),
  measurement_type: measurementTypeSchema.nullable(),
  unit: z.string().nullable(),
  patient_specific: z.boolean().nullable(),
});
export type DraftIssue = z.infer<typeof draftIssueSchema>;

export const clarificationSchema = z.object({
  id: z.string(),
  kind: clarificationKindSchema,
  question: z.string(),
  options: z.array(z.string()),
  target_id: z.string().nullable(),
  phrase: z.string().nullable(),
  measurement_type: measurementTypeSchema.nullable(),
  unit: z.string().nullable(),
  patient_specific: z.boolean().nullable(),
  asked_at: isoDateTimeSchema,
  source: z.enum(["agent", "backend"]),
  answer: z.string().nullable(),
  answered_at: isoDateTimeSchema.nullable(),
});
export type Clarification = z.infer<typeof clarificationSchema>;

// ---------------------------------------------------------------------------------------------
// Input shapes proposed by the voice agent (permissive; the backend normalizes them)
// ---------------------------------------------------------------------------------------------

export const measurementInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe("Id of an item already on the draft when correcting it. Omit this for a new measurement."),
  type: measurementTypeSchema.describe(
    "Measurement type. blood_pressure requires systolic and diastolic; the others require value.",
  ),
  systolic: finiteNumberSchema.optional().describe("Systolic pressure, for example 138. Blood pressure only."),
  diastolic: finiteNumberSchema.optional().describe("Diastolic pressure, for example 88. Blood pressure only."),
  value: finiteNumberSchema
    .optional()
    .describe("The number for blood glucose, temperature, heart rate, or oxygen saturation."),
  unit: z
    .string()
    .optional()
    .describe(
      "Exactly one of: mmHg (blood_pressure), mmol/L or mg/dL (blood_glucose), °C or °F (temperature), bpm (heart_rate), % (oxygen_saturation). Omit when the caregiver did not say a unit.",
    ),
  observed_at: isoDateTimeSchema.optional().describe("ISO 8601 instant when this was measured, only if it is known."),
  time_precision: timePrecisionSchema.optional(),
  time_source_text: z
    .string()
    .optional()
    .describe("The caregiver's own words for when it happened, for example 'this morning'."),
  time_status: timeStatusSchema.optional(),
  source_text: z.string().min(1).describe("The caregiver's exact words that support this value."),
  resolution_status: resolutionStatusSchema
    .optional()
    .describe("Set to 'ambiguous' only when you are unsure and must ask the caregiver before this can be stored."),
  ambiguity_note: z.string().optional().describe("One short sentence: what is uncertain."),
  clarification_question: z.string().optional().describe("The single question to ask the caregiver about this ambiguity."),
  expression_id: z.string().optional().describe("Set when a remembered personal expression produced this value."),
});
export type MeasurementInput = z.infer<typeof measurementInputSchema>;

export const observationInputSchema = z.object({
  id: z.string().optional().describe("Id of an item already on the draft when correcting it. Omit for a new observation."),
  category: observationCategorySchema.describe(
    "pain, food_intake, mood, sleep, symptom for a specific complaint, or other for anything that does not fit.",
  ),
  text: z.string().min(1).describe("Short plain-language statement, for example 'Pain in the left knee'."),
  body_location: z.string().optional().describe("Body location when the caregiver names one, for example 'left knee'."),
  negated: z
    .boolean()
    .optional()
    .describe("True when the caregiver says the symptom or event did not happen, for example 'no pain today'."),
  observed_at: isoDateTimeSchema.optional(),
  time_precision: timePrecisionSchema.optional(),
  time_source_text: z.string().optional(),
  time_status: timeStatusSchema.optional(),
  source_text: z.string().min(1).describe("The caregiver's exact words that support this observation."),
  resolution_status: resolutionStatusSchema.optional(),
  ambiguity_note: z.string().optional(),
  clarification_question: z.string().optional(),
});
export type ObservationInput = z.infer<typeof observationInputSchema>;

// ---------------------------------------------------------------------------------------------
// Voice agent tool arguments (the JSON Schema for the AssemblyAI tools is generated from these)
// ---------------------------------------------------------------------------------------------

const expectedRevisionField = z
  .number()
  .int()
  .positive()
  .describe("The draft revision you are updating. The app fills this in; never guess it.");

export const updateDraftArgsSchema = z.object({
  expected_revision: expectedRevisionField,
  observation_time: isoDateTimeSchema
    .nullish()
    .describe("ISO 8601 instant for the report as a whole, when the caregiver stated one."),
  observation_time_status: timeStatusSchema.optional(),
  observation_time_source_text: z.string().nullish().describe("The caregiver's own words, for example 'this morning'."),
  measurements: z.array(measurementInputSchema).optional().describe("Measurements to add or update."),
  observations: z.array(observationInputSchema).optional().describe("Observations to add or update."),
  remove_measurement_ids: z.array(z.string()).optional().describe("Ids of measurements the caregiver wants removed."),
  remove_observation_ids: z.array(z.string()).optional().describe("Ids of observations the caregiver wants removed."),
  transcript: z.string().optional().describe("The caregiver's final transcript for this report."),
});
export type UpdateDraftArgs = z.infer<typeof updateDraftArgsSchema>;

export const askCaregiverArgsSchema = z.object({
  expected_revision: expectedRevisionField,
  question: z.string().min(1).describe("One short question to ask the caregiver right now."),
  kind: clarificationKindSchema.describe(
    "unit, value, time, expression, subject, confirmation, or generic. Use 'expression' when asking permission to remember a personal phrase.",
  ),
  target_id: z.string().optional().describe("The measurement or observation id the question is about."),
  options: z.array(z.string()).optional().describe("Short answer choices when the answer is a closed set."),
  phrase: z.string().optional().describe("The caregiver's phrase. Required for kind='expression'."),
  measurement_type: measurementTypeSchema.optional().describe("The meaning proposed for a personal phrase."),
  unit: z.string().optional().describe("The unit of the proposed meaning for a personal phrase."),
  patient_specific: z.boolean().optional().describe("True when the phrase should apply to this patient only."),
});
export type AskCaregiverArgs = z.infer<typeof askCaregiverArgsSchema>;

export const rememberExpressionArgsSchema = z.object({
  expected_revision: expectedRevisionField,
  phrase: z.string().min(1).describe("The caregiver's exact phrase, for example 'her engine'."),
  measurement_type: measurementTypeSchema.describe("The meaning the caregiver confirmed."),
  unit: z.string().optional().describe("The unit that belongs to the confirmed meaning, when the type has more than one."),
  patient_specific: z.boolean().describe("True to remember it for this patient only; false for every patient of this caregiver."),
  confirmed_by_caregiver: z
    .boolean()
    .describe(
      "True only after the caregiver answered yes to the question about remembering this phrase. False records that they declined and stores nothing.",
    ),
});
export type RememberExpressionArgs = z.infer<typeof rememberExpressionArgsSchema>;

export const confirmPatientUnitArgsSchema = z.object({
  expected_revision: expectedRevisionField,
  measurement_type: measurementTypeSchema,
  unit: z.string().min(1).describe("The unit the caregiver said their device uses."),
  measurement_id: z.string().optional().describe("Apply the unit to this measurement when it is already on the draft."),
  remember_for_future_reports: z.boolean().describe("True only when the caregiver agreed to save this unit for future reports."),
  confirmed_by_caregiver: z.boolean().describe("True only after the caregiver confirmed the unit in this conversation."),
});
export type ConfirmPatientUnitArgs = z.infer<typeof confirmPatientUnitArgsSchema>;

export const finishDraftArgsSchema = z.object({
  expected_revision: expectedRevisionField,
  summary_sentence: z.string().optional().describe("Optional one-sentence summary you intend to read back."),
});
export type FinishDraftArgs = z.infer<typeof finishDraftArgsSchema>;

export const AGENT_TOOL_NAMES = [
  "update_draft",
  "ask_caregiver",
  "remember_expression",
  "confirm_patient_unit",
  "finish_draft",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const agentToolCallSchema = z.object({
  name: z.enum(AGENT_TOOL_NAMES),
  arguments: z.record(z.string(), z.unknown()),
  expected_revision: z.number().int().positive(),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

// ---------------------------------------------------------------------------------------------
// Draft snapshots and the request payloads the backend accepts
// ---------------------------------------------------------------------------------------------

// The exact content a caregiver heard and saw at one revision (spec/05 "Draft revision").
export const draftSnapshotSchema = z.object({
  revision: z.number().int().positive(),
  status: z.enum(DRAFT_STATUSES),
  observation_time: isoDateTimeSchema.nullable(),
  observation_time_precision: timePrecisionSchema,
  observation_time_source_text: z.string().nullable(),
  transcript: z.string(),
  measurements: z.array(measurementSchema),
  observations: z.array(observationSchema),
  unresolved_issues: z.array(draftIssueSchema),
});
export type DraftSnapshot = z.infer<typeof draftSnapshotSchema>;

export const draftRecordSchema = draftSnapshotSchema.extend({
  id: z.string(),
  patient_id: z.string(),
  patient_name: z.string(),
  caregiver_id: z.string(),
  session_id: z.string().nullable(),
  entry_time: isoDateTimeSchema,
  readback: z.string(),
  unresolved_statement: z.string().nullable(),
  confirmed_revision: z.number().int().positive().nullable(),
  confirmation_method: confirmationMethodSchema.nullable(),
  confirmed_at: isoDateTimeSchema.nullable(),
  current_report_id: z.string().nullable(),
  clarifications: z.array(clarificationSchema),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

export const draftPatchSchema = z.object({
  expected_revision: z.number().int().positive(),
  reason: revisionReasonSchema
    .default("caregiver_correction")
    .describe("caregiver_correction for an edit, clarification_answer when answering a question."),
  observation_time: isoDateTimeSchema.nullish(),
  observation_time_status: timeStatusSchema.optional(),
  observation_time_source_text: z.string().nullish(),
  measurements: z.array(measurementInputSchema).optional(),
  observations: z.array(observationInputSchema).optional(),
  remove_measurement_ids: z.array(z.string()).optional(),
  remove_observation_ids: z.array(z.string()).optional(),
  transcript: z.string().optional(),
  resolve_issue_ids: z
    .array(z.string())
    .optional()
    .describe("Ids of report-level questions (for example an expression permission) that are now answered."),
  answer_clarification_id: z.string().optional().describe("Marks the matching question as answered."),
  answer_text: z.string().optional().describe("What the caregiver answered, for the audit trail."),
});
export type DraftPatch = z.infer<typeof draftPatchSchema>;

export const draftConfirmSchema = z.object({
  expected_revision: z.number().int().positive(),
  method: confirmationMethodSchema.default("button"),
  confirmed_by: z.literal("caregiver").default("caregiver"),
});
export type DraftConfirm = z.infer<typeof draftConfirmSchema>;

export const draftSaveSchema = z.object({
  expected_revision: z.number().int().positive(),
  confirmed_revision: z.number().int().positive(),
  idempotency_key: z.string().min(8).max(120),
});
export type DraftSave = z.infer<typeof draftSaveSchema>;

export const draftCreateSchema = z.object({
  patient_id: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  transcript: z.string().optional(),
});
export type DraftCreate = z.infer<typeof draftCreateSchema>;

// A remembered personal expression (FR-050 - FR-052). `approved` must be true: the browser sends
// this only after an explicit confirmation, and the payload documents that consent.
export const expressionCreateSchema = z.object({
  phrase: z.string().min(1).max(120),
  measurement_type: measurementTypeSchema,
  unit: z.string().min(1).nullable().optional(),
  patient_specific: z.boolean().default(true),
  approved: z.literal(true),
  approved_via: z.enum(["button", "voice"]).default("button"),
});
export type ExpressionCreate = z.infer<typeof expressionCreateSchema>;

export const expressionPatchSchema = z.object({
  phrase: z.string().min(1).max(120).optional(),
  measurement_type: measurementTypeSchema.optional(),
  unit: z.string().min(1).nullable().optional(),
  patient_specific: z.boolean().optional(),
  approved: z.literal(true),
});
export type ExpressionPatch = z.infer<typeof expressionPatchSchema>;

export const expressionRecordSchema = z.object({
  id: z.string(),
  caregiver_id: z.string(),
  patient_id: z.string().nullable(),
  patient_name: z.string().nullable(),
  phrase: z.string(),
  measurement_type: measurementTypeSchema,
  unit: z.string().nullable(),
  context_constraints: z.record(z.string(), z.unknown()),
  confirmed_at: isoDateTimeSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});
export type ExpressionRecord = z.infer<typeof expressionRecordSchema>;

export const reportRecordSchema = z.object({
  id: z.string(),
  draft_id: z.string(),
  confirmed_revision: z.number().int().positive(),
  confirmation_method: confirmationMethodSchema,
  confirmed_at: isoDateTimeSchema,
  patient_id: z.string(),
  patient_name: z.string(),
  caregiver_name: z.string(),
  observation_time: isoDateTimeSchema.nullable(),
  observation_time_precision: timePrecisionSchema.nullable(),
  observation_time_source_text: z.string().nullable(),
  entry_time: isoDateTimeSchema,
  saved_at: isoDateTimeSchema,
  original_transcript: z.string(),
  measurements: z.array(measurementSchema),
  observations: z.array(observationSchema),
  superseded_by_report_id: z.string().nullable(),
  supersedes_report_id: z.string().nullable(),
});
export type ReportRecord = z.infer<typeof reportRecordSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["ready", "degraded", "misconfigured"]),
  database: z.enum(["ready", "unavailable", "not_configured"]),
  voice: z.enum(["ready", "not_configured", "unavailable"]),
  checked_at: isoDateTimeSchema,
  message: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const bootstrapResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    expires_at: isoDateTimeSchema,
    created_at: isoDateTimeSchema,
    is_new: z.boolean(),
  }),
  caregiver: z.object({
    id: z.string(),
    display_name: z.string(),
    timezone: z.string(),
  }),
  patients: z.array(
    z.object({
      id: z.string(),
      display_name: z.string(),
      preferred_units: z.record(z.string(), z.unknown()),
    }),
  ),
  current_draft: draftRecordSchema.nullable(),
  expressions: z.array(expressionRecordSchema),
  reports_count: z.number().int().nonnegative(),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
  draft?: DraftRecord | null;
};



