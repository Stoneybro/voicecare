import type { UnresolvedIssue } from "@/lib/extraction";

export type ClarificationIssue = UnresolvedIssue;

export function clarificationPrompt(issues: ClarificationIssue[]): string {
  const openIssue = issues[0];
  return [
    "You are VoiceCare's brief clarification assistant for a caregiver recording a health update.",
    "Ask only the unresolved detail provided below, one question at a time. Do not diagnose, recommend treatment, or interpret whether a value is medically safe.",
    "Listen to the caregiver's answer, then call the submit_clarification_answer tool with their answer verbatim. Do not claim an answer was saved until the tool confirms it.",
    "If the answer does not resolve the question, politely ask the same question again in simpler words. Keep replies short and warm.",
    `Current unresolved detail: ${openIssue ? `${openIssue.message} Ask: ${openIssue.question}` : "There are no unresolved details."}`,
  ].join("\n");
}

export function clarificationQuestion(issues: ClarificationIssue[]): string {
  return issues[0]?.question ?? "All set. You can review the update now.";
}

function unitFromAnswer(type: string, answer: string): string | null {
  if (type === "blood_glucose") {
    if (/\b(?:mg\s*\/?\s*dl|milligrams? per deciliter)\b/i.test(answer)) return "mg/dL";
    if (/\b(?:mmol\s*\/?\s*l|millimoles? per liter)\b/i.test(answer)) return "mmol/L";
  }
  if (type === "temperature") {
    if (/\b(?:celsius|degrees?\s*c|°\s*c)\b/i.test(answer)) return "°C";
    if (/\b(?:fahrenheit|degrees?\s*f|°\s*f)\b/i.test(answer)) return "°F";
  }
  return null;
}

function addUnitToSource(source: string, type: string, unit: string): string {
  const pattern = type === "blood_glucose"
    ? /(\b(?:glucose|sugar)(?:\s+(?:level|reading))?\b[^\d]{0,30}\d+(?:\.\d+)?)(?![\d])/i
    : /(\b(?:temperature|temp)\b[^\d]{0,24}\d{2,3}(?:\.\d+)?)/i;
  return source.replace(pattern, (match) => `${match} ${unit}`);
}

export function amendTranscriptForClarification(
  transcript: string,
  issue: ClarificationIssue,
  answer: string,
): string {
  if (issue.type === "missing_unit" && issue.measurement_type) {
    const unit = unitFromAnswer(issue.measurement_type, answer);
    if (!unit) return transcript;
    const corrected = addUnitToSource(issue.source_text, issue.measurement_type, unit);
    return corrected !== issue.source_text ? transcript.replace(issue.source_text, corrected) : transcript;
  }

  if (issue.type === "observation_time_missing") {
    return `${transcript.trim()} Caregiver clarification about the observation time: ${answer.trim()}.`;
  }

  const measurementType = issue.measurement_type;
  if (!measurementType) return transcript;
  let normalized: string | null = null;
  if (measurementType === "blood_pressure") {
    const values = /\b(\d{2,3})\s*(?:over|\/)\s*(\d{2,3})\b/i.exec(answer);
    if (values) normalized = `Blood pressure was ${values[1]} over ${values[2]}.`;
  } else if (measurementType === "blood_glucose") {
    const value = /\b(\d+(?:\.\d+)?)\b/.exec(answer);
    const unit = unitFromAnswer(measurementType, answer);
    if (value) normalized = `Blood glucose was ${value[1]}${unit ? ` ${unit}` : ""}.`;
  } else if (measurementType === "temperature") {
    const value = /\b(\d{2,3}(?:\.\d+)?)\b/.exec(answer);
    const unit = unitFromAnswer(measurementType, answer);
    if (value) normalized = `Temperature was ${value[1]}${unit ? ` ${unit}` : ""}.`;
  } else if (measurementType === "heart_rate") {
    const value = /\b(\d{2,3})\b/.exec(answer);
    if (value) normalized = `Heart rate was ${value[1]} bpm.`;
  } else if (measurementType === "spo2") {
    const value = /\b(\d{2,3})\s*(?:%|percent)?\b/i.exec(answer);
    if (value) normalized = `Oxygen saturation was ${value[1]}%.`;
  }
  return normalized ? `${transcript.trim()} ${normalized}` : transcript;
}
