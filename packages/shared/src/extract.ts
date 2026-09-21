// Rule-based extraction for the typed-observation fallback (spec/03 FR-015).
//
// The voice agent extracts fields through tool calls. When the microphone is unavailable, the same
// caregiver sentence must still produce a structured draft, so this module applies the same
// patterns locally and emits MeasurementInput/ObservationInput objects. Those go through the exact
// same backend resolution rules (resolve.ts), so a typed observation cannot skip validation.

import { isNumberWord, resolveSpokenNumbers, splitCompoundNumberToken } from "./numbers.ts";
import type { MeasurementInput, ObservationInput } from "./schemas.ts";
import type { KnownExpression } from "./resolve.ts";
import { findTimePhrase, resolveTimePhrase } from "./time.ts";
import type { MeasurementType, ObservationCategory, TimePrecision, TimeStatus } from "./vocab.ts";

export type ExtractionNote = { code: string; message: string };

export type ExtractionResult = {
  transcript: string;
  measurements: MeasurementInput[];
  observations: ObservationInput[];
  reportTime: { observed_at: string | null; precision: TimePrecision; status: TimeStatus; source_text: string | null };
  notes: ExtractionNote[];
};

export type ExtractOptions = {
  now: Date;
  timeZone: string;
  patientUnits?: Partial<Record<MeasurementType, string>>;
  expressions?: KnownExpression[];
};

const NUMBER_PATTERN = /\b\d+(?:\.\d+)?\b/;

const MEASUREMENT_KEYWORDS: Array<{ type: MeasurementType; pattern: RegExp }> = [
  { type: "blood_pressure", pattern: /\b(blood pressure|pressure|bp)\b/ },
  { type: "blood_glucose", pattern: /\b(blood sugar|blood glucose|sugar|glucose)\b/ },
  { type: "temperature", pattern: /\b(temperature|temp|fever)\b/ },
  { type: "heart_rate", pattern: /\b(heart rate|heartbeat|heart|pulse|beats)\b/ },
  { type: "oxygen_saturation", pattern: /\b(oxygen|saturation|sat|spo2|o2)\b/ },
];

const UNIT_WORDS: Array<{ pattern: RegExp; unit: string; type?: MeasurementType }> = [
  { pattern: /\bmmol\b|\bmillimoles?\b/, unit: "mmol/L", type: "blood_glucose" },
  { pattern: /\bmg\/?dl\b|\bmilligrams? per decilitre\b|\bmilligrams? per deciliter\b/, unit: "mg/dL", type: "blood_glucose" },
  { pattern: /\bcelsius\b|\bcentigrade\b|\bdegrees? c\b/, unit: "°C", type: "temperature" },
  { pattern: /\bfahrenheit\b|\bdegrees? f\b/, unit: "°F", type: "temperature" },
  { pattern: /\bbeats? per minute\b|\bbpm\b/, unit: "bpm", type: "heart_rate" },
  { pattern: /\bpercent\b|%/, unit: "%", type: "oxygen_saturation" },
  { pattern: /\bmmhg\b|\bmillimetres of mercury\b|\bmillimeters of mercury\b/, unit: "mmHg", type: "blood_pressure" },
];

const OBSERVATION_KEYWORDS: Array<{ category: ObservationCategory; pattern: RegExp }> = [
  { category: "pain", pattern: /\b(pain|painful|hurts?|hurting|ache|aching|aching|sore|tender|throbbing|cramp|cramping)\b/ },
  {
    category: "food_intake",
    pattern: /\b(ate|eaten|eating|drink|drank|appetite|meal|breakfast|lunch|dinner|supper|snack|food|fluids?|hydration|feeding)\b/,
  },
  {
    category: "mood",
    pattern: /\b(mood|happy|sad|anxious|anxiety|worried|irritable|upset|calm|cheerful|withdrawn|agitated|confused)\b/,
  },
  { category: "sleep", pattern: /\b(sleep|slept|sleeping|nap|napped|awake|insomnia|restless)\b/ },
  {
    category: "symptom",
    pattern:
      /\b(cough|coughing|nausea|nauseous|vomit|vomiting|dizzy|dizziness|rash|swelling|swollen|breathless|short of breath|tired|fatigue|weak|constipation|constipated|diarrhoea|diarrhea|chills|sweating|bleeding|bruise|bruising)\b/,
  },
];

const NEGATION_PATTERN = /\b(no|not|none|without|denies|denied|never|negative for|stopped|hasn't|has not|didn't|did not)\b/;

// A comma after one of these words continues the same statement ("72, sorry, 74").
const CORRECTION_MARKERS = new Set(["sorry", "actually", "rather", "mean", "no"]);

const BODY_PARTS =
  /\b(left|right)?\s*(knees?|shoulders?|elbows?|wrists?|hands?|fingers?|hips?|thighs?|legs?|ankles?|feet|foot|toes?|backs?|necks?|chests?|stomachs?|abdomens?|belly|heads?|faces?|ears?|eyes?|tooths?|teeth|arms?|joints?|muscles?|skin|throats?|sinuses?)\b/;

// Phrases that report the act of checking rather than an observation.
const ENCOUNTER_PATTERN =
  /^(i|we)\s+(just\s+|have\s+just\s+)?(checked|checking|saw|see|visited|am calling|'m calling|wanted to (say|report|tell)|am reporting|'m reporting|noticed|noticing|am writing|'m writing)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNumberToken(token: string): boolean {
  const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  if (bare.length === 0) return false;
  return splitCompoundNumberToken(bare).every((part) => isNumberWord(part));
}

// Clauses are split on punctuation and on "and"/"but"/"then", except when the conjunction joins a
// spoken number ("one hundred and thirty-eight" must stay one value).
export function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  const tokens = text.match(/\S+/g) ?? [];
  let current = "";
  const flush = (): void => {
    const cleaned = current.replace(/^[\s,;.!?]+|[\s,;.!?]+$/g, "");
    if (cleaned.length > 0) clauses.push(cleaned);
    current = "";
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    const isConjunction = bare === "and" || bare === "but" || bare === "then";
    if (isConjunction) {
      const previous = tokens[index - 1] ?? "";
      const next = tokens[index + 1] ?? "";
      if (isNumberToken(previous) && isNumberToken(next)) {
        current += (current.length > 0 ? " " : "") + token;
        continue;
      }
      // A conjunction separates two statements; it is not part of either one.
      flush();
      continue;
    }
    current += (current.length > 0 ? " " : "") + token;
    const endsSentence = /[;.!?]$/.test(token);
    const endsWithComma = /,$/.test(token);
    const lastWord = token
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0)
      .pop();
    // "...seventy—sorry, seventy-two" keeps the correction inside one clause.
    if (endsSentence || (endsWithComma && !(lastWord !== undefined && CORRECTION_MARKERS.has(lastWord)))) flush();
  }
  flush();
  return clauses;
}

// "Seventy—sorry, seventy-two" and "37.2, not 37.4" keep the corrected value only.
export function applySelfCorrections(text: string): { text: string; corrections: string[] } {
  const corrections: string[] = [];
  let working = text;
  const spoken = /\b(\d+(?:\.\d+)?)\s*(?:[—–-]?\s*(?:sorry|i mean|actually|rather|make that|no,? make that)\s*,?\s*)(\d+(?:\.\d+)?)\b/gi;
  working = working.replace(spoken, (_match, first: string, second: string) => {
    corrections.push(`The caregiver corrected ${first} to ${second}.`);
    return second;
  });
  const trailingNegation = /,?\s*\bnot\s+\d+(?:\.\d+)?\b/gi;
  if (trailingNegation.test(working) && (working.match(/\d+(?:\.\d+)?/g) ?? []).length >= 2) {
    const removed = working.match(trailingNegation) ?? [];
    working = working.replace(trailingNegation, "");
    corrections.push(`The caregiver replaced an earlier value${removed.length > 1 ? "s" : ""} with the corrected one.`);
  }
  return { text: working.replace(/\s{2,}/g, " ").trim(), corrections };
}

function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map((value) => Number.parseFloat(value));
}

function findUnit(lower: string, type: MeasurementType): string | undefined {
  for (const candidate of UNIT_WORDS) {
    if (candidate.type !== type) continue;
    if (candidate.pattern.test(lower)) return candidate.unit;
  }
  return undefined;
}

function findBodyLocation(lower: string): string | undefined {
  const match = lower.match(BODY_PARTS);
  if (!match) return undefined;
  const side = match[1];
  const part = match[2];
  return side ? `${side} ${part}` : part;
}

function isNegated(lower: string): boolean {
  return NEGATION_PATTERN.test(lower);
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

type ClauseTime = { observed_at: string; time_precision: TimePrecision; time_source_text: string; time_status: TimeStatus };

function timeFields(time: ClauseTime | null): Partial<ClauseTime> {
  if (!time) return {};
  return {
    observed_at: time.observed_at,
    time_precision: time.time_precision,
    time_source_text: time.time_source_text,
    time_status: time.time_status,
  };
}

function measurementFromClause(
  resolved: string,
  original: string,
  type: MeasurementType,
  time: ClauseTime | null,
): MeasurementInput | null {
  const values = numbersIn(resolved);
  if (values.length === 0) return null;
  const unit = findUnit(resolved.toLowerCase(), type);
  const base: MeasurementInput = {
    type,
    source_text: original,
    ...timeFields(time),
    ...(unit ? { unit } : {}),
  };
  if (type === "blood_pressure") {
    const pair = resolved.match(/\b(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})\b/);
    if (pair) {
      return { ...base, systolic: Number.parseFloat(pair[1]), diastolic: Number.parseFloat(pair[2]) };
    }
    // Only one number heard: keep it so the backend asks for the missing value.
    return { ...base, systolic: values[0] };
  }
  return { ...base, value: values[0] };
}

function observationFromClause(
  clause: { original: string; resolved: string },
  time: ClauseTime | null,
): ObservationInput | null {
  const lower = clause.resolved.toLowerCase();
  const matched = OBSERVATION_KEYWORDS.find((candidate) => candidate.pattern.test(lower));
  if (!matched) {
    if (ENCOUNTER_PATTERN.test(lower)) return null;
    const words = lower.split(/\s+/).filter((word) => word.length > 1);
    if (!NUMBER_PATTERN.test(lower) && words.length < 3) return null;
    return {
      category: "other",
      text: sentenceCase(clause.resolved),
      source_text: clause.original,
      negated: isNegated(lower),
      ...timeFields(time),
    };
  }
  const location = matched.category === "pain" || matched.category === "symptom" ? findBodyLocation(lower) : undefined;
  const negated = isNegated(lower);
  const text =
    matched.category === "pain"
      ? location
        ? `Pain in the ${location}`
        : sentenceCase(clause.resolved)
      : sentenceCase(clause.resolved);
  return {
    category: matched.category,
    text,
    ...(location ? { body_location: location } : {}),
    negated,
    source_text: clause.original,
    ...timeFields(time),
  };
}

export function extractCareReport(transcript: string, options: ExtractOptions): ExtractionResult {
  const notes: ExtractionNote[] = [];
  const measurements: MeasurementInput[] = [];
  const observations: ObservationInput[] = [];
  const clauses = splitClauses(transcript);
  let reportTime: ExtractionResult["reportTime"] | null = null;
  let lastObservation: ObservationInput | null = null;

  for (const clause of clauses) {
    const resolvedNumbers = resolveSpokenNumbers(clause);
    const { text: corrected, corrections } = applySelfCorrections(resolvedNumbers);
    for (const correction of corrections) {
      notes.push({ code: "self_correction", message: correction });
    }
    const timePhrase = findTimePhrase(clause);
    const resolvedTime = timePhrase ? resolveTimePhrase(timePhrase, options.now, options.timeZone) : null;
    const clauseTime: ClauseTime | null = resolvedTime
      ? {
          observed_at: resolvedTime.observed_at,
          time_precision: resolvedTime.precision,
          time_source_text: resolvedTime.source_text,
          time_status: resolvedTime.status,
        }
      : null;
    if (clauseTime && reportTime === null) {
      reportTime = {
        observed_at: clauseTime.observed_at,
        precision: clauseTime.time_precision,
        status: clauseTime.time_status,
        source_text: clauseTime.time_source_text,
      };
    }

    const lower = corrected.toLowerCase();
    const hasNumber = NUMBER_PATTERN.test(corrected);
    const symptomMatched = OBSERVATION_KEYWORDS.some(
      (candidate) => (candidate.category === "pain" || candidate.category === "symptom") && candidate.pattern.test(lower),
    );
    let handled = false;

    if (hasNumber) {
      for (const keyword of MEASUREMENT_KEYWORDS) {
        if (!keyword.pattern.test(lower)) continue;
        const measurement = measurementFromClause(corrected, clause, keyword.type, clauseTime);
        if (!measurement) continue;
        measurements.push(measurement);
        handled = true;
        break;
      }
    }

    // A remembered expression applies only when no measurement keyword matched and the sentence is
    // not a symptom. "Her heart hurts" must stay a symptom even after "heart" is learned as pulse.
    if (!handled && hasNumber && !symptomMatched) {
      for (const expression of options.expressions ?? []) {
        const phrase = expression.phrase.trim().toLowerCase();
        if (phrase.length === 0) continue;
        if (!new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(lower)) continue;
        const values = numbersIn(corrected);
        if (values.length === 0) continue;
        const unit = findUnit(lower, expression.measurement_type) ?? expression.unit ?? undefined;
        measurements.push({
          type: expression.measurement_type,
          value: values[0],
          ...(unit ? { unit } : {}),
          expression_id: expression.id,
          source_text: clause,
          ...timeFields(clauseTime),
        });
        notes.push({
          code: "expression_applied",
          message: `Applied the remembered expression "${expression.phrase}".`,
        });
        handled = true;
        break;
      }
    }

    if (!handled || symptomMatched) {
      const observation = observationFromClause({ original: clause, resolved: corrected }, clauseTime);
      if (observation) {
        observations.push(observation);
        lastObservation = observation;
      } else if (isNegated(lower) && lastObservation && (clauseTime !== null || lower.split(/\s+/).length <= 5)) {
        // "She had pain yesterday, but none today." - a bare negated clause continues the item
        // before it and keeps its own time, so the two statements stay separate (FR-024).
        const continuation: ObservationInput = {
          category: lastObservation.category,
          text: lastObservation.text,
          ...(lastObservation.body_location ? { body_location: lastObservation.body_location } : {}),
          negated: true,
          source_text: clause,
          ...timeFields(clauseTime),
        };
        observations.push(continuation);
        lastObservation = continuation;
      }
    }
  }

  const reportTimeValue: ExtractionResult["reportTime"] =
    reportTime ??
    ((): ExtractionResult["reportTime"] => {
      notes.push({
        code: "time_assumed",
        message: "No time was stated, so the entry time is offered as an assumed observation time.",
      });
      return {
        observed_at: options.now.toISOString(),
        precision: "assumed",
        status: "unknown",
        source_text: null,
      };
    })();

  return {
    transcript,
    measurements,
    observations,
    reportTime: reportTimeValue,
    notes,
  };
}


