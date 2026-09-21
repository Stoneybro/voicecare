// Clarification wording. Kept in one module so the agent, the browser, and the API produce the
// same question for the same ambiguity (spec/04 "Suggested voice wording").

import type { DraftIssue } from "./schemas.ts";
import { MEASUREMENT_LABELS, UNIT_SPEECH, unitsForType, type MeasurementType } from "./vocab.ts";

export function unitQuestion(type: MeasurementType, valueText: string): string {
  const options = unitsForType(type);
  const joined = options.length === 2 ? `${options[0]} or ${options[1]}` : options[0];
  return `You said the ${MEASUREMENT_LABELS[type]} was ${valueText}. Does the device use ${joined}?`;
}

export function unsupportedUnitQuestion(type: MeasurementType, proposed: string): string {
  const options = unitsForType(type);
  return `I am not sure which unit "${proposed}" is for the ${MEASUREMENT_LABELS[type]}. Can you tell me if it is ${options.join(" or ")}?`;
}

export function valueQuestion(type: MeasurementType): string {
  if (type === "blood_pressure") {
    return "What was the blood pressure? I need both numbers, for example 138 over 88.";
  }
  return `What was the ${MEASUREMENT_LABELS[type]}? I did not catch a number.`;
}

export function timeQuestion(label: string): string {
  return `When did the ${label} happen? I need a day and a time.`;
}

export function ambiguityQuestion(sourceText: string): string {
  const quoted = sourceText.trim() || "that";
  return `I want to be sure I understood "${quoted}". Can you say it another way?`;
}

export function expressionPermissionQuestion(phrase: string, type: MeasurementType, unit: string | null): string {
  const meaning = unit ? `${MEASUREMENT_LABELS[type]} in ${unit}` : MEASUREMENT_LABELS[type];
  return `Should I remember "${phrase}" as your way of saying ${meaning} for future reports?`;
}

export function unresolvedStatement(issues: DraftIssue[]): string | null {
  const blocking = issues.filter((issue) => issue.blocking);
  if (blocking.length === 0) return null;
  const [first] = blocking;
  const extra = blocking.length > 1 ? ` There ${blocking.length - 1 === 1 ? "is 1 more" : `are ${blocking.length - 1} more`} to check.` : "";
  return `I still need to check something before this report can be saved: ${first.question}${extra}`;
}

export function unitSpeech(unit: string | null): string {
  if (!unit) return "";
  return UNIT_SPEECH[unit] ?? unit;
}
