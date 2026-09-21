// Personal expressions: stored only after separate, explicit permission (FR-050 - FR-052).
//
// The database enforces one active expression per caregiver, patient scope, and phrase, so a
// repeated request returns a conflict instead of an ambiguous duplicate.

import {
  measurementTypeSchema,
  type ExpressionCreate,
  type ExpressionPatch,
  type ExpressionRecord,
  type KnownExpression,
} from "@voicecare/shared";
import { getSql } from "./db";
import { ApiError } from "./http";
import { newId } from "./session";

type ExpressionRow = {
  id: string;
  caregiver_id: string;
  patient_id: string | null;
  patient_name: string | null;
  phrase: string;
  normalized_meaning: unknown;
  context_constraints: unknown;
  confirmed_at: string;
  created_at: string;
  updated_at: string;
};

function toRecord(row: ExpressionRow): ExpressionRecord {
  const meaning = (row.normalized_meaning ?? {}) as Record<string, unknown>;
  const context = (row.context_constraints ?? {}) as Record<string, unknown>;
  const type = measurementTypeSchema.safeParse(meaning.measurement_type);
  if (!type.success) {
    console.error("[voicecare] expression has an unsupported meaning", row.id, meaning);
    throw new ApiError(
      500,
      "expression_unreadable",
      "A remembered expression could not be read. Reset the demo to continue.",
    );
  }
  return {
    id: row.id,
    caregiver_id: row.caregiver_id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    phrase: row.phrase,
    measurement_type: type.data,
    unit: typeof meaning.unit === "string" ? meaning.unit : null,
    context_constraints: context,
    confirmed_at: new Date(row.confirmed_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

// patient_id is null for caregiver-wide expressions, so they are returned for every patient.
function selectExpressions(caregiverId: string, patientId: string | null) {
  return getSql()`
    select e.id, e.caregiver_id, e.patient_id, p.display_name as patient_name, e.phrase,
           e.normalized_meaning, e.context_constraints, e.confirmed_at, e.created_at, e.updated_at
    from personal_expressions e
    left join patients p on p.id = e.patient_id
    where e.caregiver_id = ${caregiverId}
      and e.deleted_at is null
      and (e.patient_id is null or e.patient_id = ${patientId})
    order by e.confirmed_at desc
  `;
}

export async function listExpressions(caregiverId: string, patientId: string | null): Promise<ExpressionRecord[]> {
  const rows = (await selectExpressions(caregiverId, patientId)) as ExpressionRow[];
  return rows.map(toRecord);
}

export async function listKnownExpressions(caregiverId: string, patientId: string | null): Promise<KnownExpression[]> {
  const expressions = await listExpressions(caregiverId, patientId);
  return expressions.map((expression) => ({
    id: expression.id,
    phrase: expression.phrase,
    measurement_type: expression.measurement_type,
    unit: expression.unit,
  }));
}

export async function createExpression(
  caregiverId: string,
  patientId: string | null,
  input: ExpressionCreate,
): Promise<ExpressionRecord> {
  const sql = getSql();
  const id = newId("expr");
  const targetPatientId = input.patient_specific ? patientId : null;
  const meaning = { measurement_type: input.measurement_type, unit: input.unit ?? null };
  const context = { approved_via: input.approved_via, approved_at: new Date().toISOString() };

  try {
    await sql`
      insert into personal_expressions (id, caregiver_id, patient_id, phrase, normalized_meaning, context_constraints, confirmed_at)
      values (${id}, ${caregiverId}, ${targetPatientId}, ${input.phrase.trim()}, ${JSON.stringify(meaning)}::jsonb,
              ${JSON.stringify(context)}::jsonb, now())
    `;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/duplicate key|unique/i.test(detail)) {
      throw new ApiError(409, "expression_exists", `"${input.phrase.trim()}" is already remembered. Edit it instead.`);
    }
    throw error;
  }

  const rows = (await selectExpressions(caregiverId, targetPatientId)) as ExpressionRow[];
  const created = rows.find((row) => row.id === id);
  if (!created) {
    throw new ApiError(500, "expression_not_stored", "The expression could not be stored. Please try again.");
  }
  return toRecord(created);
}

export async function updateExpression(
  caregiverId: string,
  id: string,
  patch: ExpressionPatch,
): Promise<ExpressionRecord> {
  const sql = getSql();
  const existing = (await sql`
    select id, caregiver_id, patient_id, phrase, normalized_meaning, context_constraints, confirmed_at, created_at, updated_at
    from personal_expressions
    where id = ${id} and caregiver_id = ${caregiverId} and deleted_at is null
    limit 1
  `) as ExpressionRow[];
  const current = existing[0];
  if (!current) {
    throw new ApiError(404, "expression_not_found", "That remembered expression was not found.");
  }
  const meaning = (current.normalized_meaning ?? {}) as Record<string, unknown>;
  const nextMeaning = {
    measurement_type: patch.measurement_type ?? meaning.measurement_type,
    unit: patch.unit !== undefined ? patch.unit : (meaning.unit ?? null),
  };
  const nextPhrase = patch.phrase?.trim() ?? current.phrase;
  const nextPatientId =
    patch.patient_specific === undefined ? current.patient_id : patch.patient_specific ? current.patient_id : null;

  await sql`
    update personal_expressions
    set phrase = ${nextPhrase},
        normalized_meaning = ${JSON.stringify(nextMeaning)}::jsonb,
        patient_id = ${nextPatientId},
        updated_at = now()
    where id = ${id} and caregiver_id = ${caregiverId}
  `;

  const rows = (await selectExpressions(caregiverId, nextPatientId)) as ExpressionRow[];
  const updated = rows.find((row) => row.id === id);
  if (!updated) {
    throw new ApiError(500, "expression_not_stored", "The expression could not be updated. Please try again.");
  }
  return toRecord(updated);
}

export async function softDeleteExpression(caregiverId: string, id: string): Promise<void> {
  const rows = (await getSql()`
    update personal_expressions set deleted_at = now(), updated_at = now()
    where id = ${id} and caregiver_id = ${caregiverId} and deleted_at is null
    returning id
  `) as Array<{ id: string }>;
  if (rows.length === 0) {
    throw new ApiError(404, "expression_not_found", "That remembered expression was not found.");
  }
}

