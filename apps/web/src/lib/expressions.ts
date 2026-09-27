import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import type { MeasurementType } from "@/lib/extraction";

export type PersonalExpression = {
  phrase: string;
  normalized_meaning: { measurement_type: MeasurementType; unit: string };
  context_constraints?: Record<string, unknown>;
};

export type ExpressionSuggestion = {
  suggestion_id: string;
  phrase: string;
  measurement_type: MeasurementType;
  unit: string;
};

const canonicalLabels: Record<MeasurementType, string> = {
  blood_pressure: "blood pressure",
  blood_glucose: "blood glucose",
  temperature: "temperature",
  heart_rate: "heart rate",
  spo2: "oxygen saturation",
};

export function canonicalLabel(type: MeasurementType): string {
  return canonicalLabels[type];
}

export async function loadPersonalExpressions(caregiverId: string, patientId: string): Promise<PersonalExpression[]> {
  const rows = await getSql()`
    select phrase, normalized_meaning, context_constraints
    from personal_expressions
    where caregiver_id = ${caregiverId} and deleted_at is null
      and (patient_id = ${patientId} or patient_id is null)
    order by (patient_id is not null) desc, confirmed_at desc
  ` as Array<{ phrase: string; normalized_meaning: unknown; context_constraints: unknown }>;
  return rows.flatMap((row) => {
    const meaning = row.normalized_meaning as { measurement_type?: unknown; unit?: unknown } | null;
    if (!meaning || typeof meaning.measurement_type !== "string" || typeof meaning.unit !== "string") return [];
    if (!Object.hasOwn(canonicalLabels, meaning.measurement_type)) return [];
    const constraints = row.context_constraints && typeof row.context_constraints === "object" && !Array.isArray(row.context_constraints)
      ? row.context_constraints as Record<string, unknown>
      : {};
    return [{
      phrase: row.phrase,
      normalized_meaning: { measurement_type: meaning.measurement_type as MeasurementType, unit: meaning.unit },
      context_constraints: constraints,
    }];
  });
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyPersonalExpressions(transcript: string, expressions: PersonalExpression[]): string {
  const ordered = [...expressions].filter((expression) => expression.phrase.trim()).sort((a, b) => b.phrase.length - a.phrase.length);
  if (ordered.length === 0) return transcript;
  const alternatives = ordered.map((expression) => regexEscape(expression.phrase.trim())).join("|");
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}_])(${alternatives})(?![\\p{L}\\p{N}_])`, "giu");
  return transcript.replace(matcher, (match) => {
    const expression = ordered.find((candidate) => candidate.phrase.trim().toLocaleLowerCase() === match.toLocaleLowerCase());
    if (!expression) return match;
    const canonical = canonicalLabel(expression.normalized_meaning.measurement_type);
    // Keep the alias as a short marker for unit inference and faithful source-text restoration.
    return `${canonical} ${expression.phrase}`;
  });
}

export function restorePersonalExpressionSources<T extends { source_text: string }>(
  items: T[],
  expressions: PersonalExpression[],
): T[] {
  return items.map((item) => {
    const restore = (value: string) => {
      let source = value;
      for (const expression of expressions) {
        const canonical = canonicalLabel(expression.normalized_meaning.measurement_type);
        const marker = `${canonical} ${expression.phrase}`;
        source = source.replace(new RegExp(regexEscape(marker), "ig"), expression.phrase);
      }
      return source;
    };
    const description = "description" in item && typeof item.description === "string"
      ? { description: restore(item.description) }
      : {};
    return { ...item, ...description, source_text: restore(item.source_text) };
  });
}

export function detectExpressionSuggestion(text: string): ExpressionSuggestion | null {
  const types: Array<{ type: MeasurementType; pattern: string; unit: string | null }> = [
    { type: "blood_pressure", pattern: "blood\\s+pressure|bp", unit: "mmHg" },
    { type: "heart_rate", pattern: "heart\\s+rate|pulse", unit: "bpm" },
    { type: "spo2", pattern: "oxygen\\s+saturation|oxygen\\s+level|spo\\s*2", unit: "%" },
    { type: "blood_glucose", pattern: "blood\\s+sugar|blood\\s+glucose|glucose", unit: null },
    { type: "temperature", pattern: "temperature|temp", unit: null },
  ];
  const unitPattern = "(mg\\s*\\/?\\s*dl|mmol\\s*\\/?\\s*l|celsius|fahrenheit|degrees?\\s*[cf]|°\\s*[cf])";
  const mappingPatterns = [
    new RegExp(`(?:remember(?:\\s+that)?\\s+)?[\\"'“”]?([\\p{L}\\p{N}_-]+(?:\\s+[\\p{L}\\p{N}_-]+){0,3})[\\"'“”]?\\s+(?:means|refers\\s+to|is)\\s+(?:the\\s+)?(${types.map((item) => `(?:${item.pattern})`).join("|")})(?:\\s+(?:in|measured\\s+in)\\s+${unitPattern})?`, "iu"),
    new RegExp(`(?:I|we)\\s+call\\s+[\\"'“”]?([\\p{L}\\p{N}_-]+(?:\\s+[\\p{L}\\p{N}_-]+){0,3})[\\"'“”]?\\s+(?:the\\s+)?(${types.map((item) => `(?:${item.pattern})`).join("|")})(?:\\s+(?:in|measured\\s+in)\\s+${unitPattern})?`, "iu"),
  ];

  for (const pattern of mappingPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const phrase = match[1].replace(/^(?:the\s+word|word|a\s+term)\s+/i, "").trim().replace(/^[\"'“”]|[\"'“”]$/g, "");
    const normalized = phrase.toLocaleLowerCase();
    if (phrase.length < 2 || phrase.length > 50 || /^\p{N}+$/u.test(phrase) || /^(?:heart rate|blood pressure|blood sugar|glucose|temperature|pulse|spo2)$/i.test(normalized)) continue;
    const target = match[2].toLowerCase().replace(/\s+/g, " ");
    const mapping = types.find((item) => new RegExp(`^(?:${item.pattern})$`, "i").test(target));
    if (!mapping) continue;
    let unit = mapping.unit;
    const declaredUnit = match[3]?.toLowerCase() ?? "";
    if (mapping.type === "blood_glucose") {
      if (/mg/.test(declaredUnit)) unit = "mg/dL";
      else if (/mmol/.test(declaredUnit)) unit = "mmol/L";
    } else if (mapping.type === "temperature") {
      if (/celsius|°\s*c|degrees?\s*c/.test(declaredUnit)) unit = "°C";
      else if (/fahrenheit|°\s*f|degrees?\s*f/.test(declaredUnit)) unit = "°F";
    }
    // A learned glucose/temperature alias must carry its scale or it would simply re-create a blocker.
    if (!unit) continue;
    const suggestionId = createHash("sha256").update(`${normalized}:${mapping.type}:${unit}`).digest("hex").slice(0, 24);
    return { suggestion_id: suggestionId, phrase, measurement_type: mapping.type, unit };
  }
  return null;
}

export async function loadSuggestionForDraft(draftId: string, caregiverId: string, suggestionId: string) {
  const rows = await getSql()`
    select d.id, d.patient_id, p.display_name as patient_name, d.clarification_log
    from drafts d join patients p on p.id = d.patient_id and p.caregiver_id = d.caregiver_id
    where d.id = ${draftId} and d.caregiver_id = ${caregiverId}
    limit 1
  ` as Array<{ id: string; patient_id: string; patient_name: string; clarification_log: unknown }>;
  const draft = rows[0];
  if (!draft) return null;
  const entries = Array.isArray(draft.clarification_log) ? draft.clarification_log as Array<{ resolved?: boolean; memory_suggestion?: ExpressionSuggestion }> : [];
  const suggestion = entries.filter((entry) => entry.resolved).map((entry) => entry.memory_suggestion)
    .find((candidate) => candidate?.suggestion_id === suggestionId);
  return suggestion ? { ...suggestion, patient_id: draft.patient_id, patient_name: draft.patient_name } : null;
}
