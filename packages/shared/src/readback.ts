// Readback wording (spec/03 FR-040, spec/04 "Suggested voice wording").
//
// The same strings are used for the spoken readback, the visible draft summary, and the printable
// summary, so what the caregiver hears and sees cannot diverge.

import { unresolvedStatement } from "./questions.ts";
import { formatValueText } from "./resolve.ts";
import type { DraftSnapshot, Measurement, Observation } from "./schemas.ts";
import { CATEGORY_LABELS, MEASUREMENT_LABELS, UNIT_SPEECH } from "./vocab.ts";
import { formatInstant } from "./time.ts";

export function describeMeasurement(measurement: Measurement): string {
  const unit = measurement.unit ? ` ${measurement.unit}` : " unit not set";
  const settingNote = measurement.unit_source === "patient_setting" ? " (from your saved setting)" : "";
  return `${MEASUREMENT_LABELS[measurement.type]} ${formatValueText(measurement.type, measurement)}${unit}${settingNote}`;
}

export function describeObservation(observation: Observation): string {
  const base = observation.negated ? `no ${lowerFirst(observation.text)}` : lowerFirst(observation.text);
  return base;
}

export function measurementSpokenPhrase(measurement: Measurement): string {
  const unit = measurement.unit ? ` ${UNIT_SPEECH[measurement.unit] ?? measurement.unit}` : "";
  const settingNote = measurement.unit_source === "patient_setting" ? ", from your saved setting" : "";
  const warning = measurement.warning ? ", which looks unusual, so please double-check it" : "";
  return `${MEASUREMENT_LABELS[measurement.type]} ${formatValueText(measurement.type, measurement)}${unit}${settingNote}${warning}`;
}

function lowerFirst(value: string): string {
  if (value.length === 0) return value;
  return value[0].toLowerCase() + value.slice(1);
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function describeObservationTime(snapshot: {
  observation_time: string | null;
  observation_time_precision?: string | null;
  observation_time_source_text: string | null;
}, timeZone = "UTC"): string | null {
  if (snapshot.observation_time === null) return "I do not have a time for this yet.";
  if (snapshot.observation_time_precision === "assumed") {
    return "I used the time you sent this in as the observation time.";
  }
  if (snapshot.observation_time_source_text) {
    return `The time was ${snapshot.observation_time_source_text}.`;
  }
  return `The time was ${formatInstant(snapshot.observation_time, timeZone)}.`;
}

export function buildReadback(snapshot: DraftSnapshot, options: { patientName: string; timeZone: string }): string {
  const sentences: string[] = [];
  if (snapshot.measurements.length > 0) {
    sentences.push(`I have ${joinList(snapshot.measurements.map(measurementSpokenPhrase))}.`);
  }
  if (snapshot.observations.length > 0) {
    sentences.push(`I also noted ${joinList(snapshot.observations.map(describeObservation))}.`);
  }
  const timeSentence = describeObservationTime(snapshot, options.timeZone);
  if (timeSentence) sentences.push(timeSentence);
  const unresolved = unresolvedStatement(snapshot.unresolved_issues);
  if (unresolved) {
    sentences.push(unresolved);
  } else if (sentences.length > 0) {
    sentences.push("Is that correct?");
  }
  if (sentences.length === 0) {
    return `I do not have anything to read back for ${options.patientName} yet.`;
  }
  return sentences.join(" ");
}

export function buildDraftSummaryLines(snapshot: DraftSnapshot): string[] {
  const lines: string[] = [];
  for (const measurement of snapshot.measurements) {
    const unit = measurement.unit ? ` ${measurement.unit}` : "";
    lines.push(`${MEASUREMENT_LABELS[measurement.type]}: ${formatValueText(measurement.type, measurement)}${unit}`);
  }
  for (const observation of snapshot.observations) {
    lines.push(`${CATEGORY_LABELS[observation.category]}: ${describeObservation(observation)}`);
  }
  return lines;
}
