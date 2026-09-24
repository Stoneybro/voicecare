// Deterministic multi-format exports (no LLM, no hallucination).
//
// One set of confirmed reports renders three ways:
//   Doctor  - structured, SOAP-inspired: Subjective (caregiver observations) +
//             Objective (vitals table). No Assessment/Plan: we record, never diagnose.
//   Family  - plain language, one short paragraph per report.
//   Files   - JSON (full fidelity) + CSV (one row per measurement/observation)
//             so other members or a clinic system can carry the data forward.
//
// All functions are pure: same reports in, same text out. The disclaimer travels
// with every format.

import { CATEGORY_LABELS, MEASUREMENT_LABELS } from "./vocab.ts";
import type { ReportRecord } from "./schemas.ts";

export const EXPORT_DISCLAIMER =
  "Caregiver-reported observations. Review before making medical decisions. Not a clinical record or diagnosis.";

function formatWhen(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function measurementValueText(type: string, systolic: number | null, diastolic: number | null, value: number | null): string {
  if (type === "blood_pressure") return `${systolic ?? "?"} / ${diastolic ?? "?"}`;
  return value === null || value === undefined ? "?" : String(value);
}

function measurementLabel(type: string): string {
  return (MEASUREMENT_LABELS as Record<string, string>)[type] ?? type.replace(/_/g, " ");
}

function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[category] ?? category.replace(/_/g, " ");
}

export function buildDoctorText(reports: ReportRecord[], patientName: string): string {
  const lines: string[] = [
    `Care report for ${patientName}`,
    EXPORT_DISCLAIMER,
    `Reports: ${reports.length}`,
    "",
  ];
  for (const report of [...reports].sort((a, b) => String(a.observation_time ?? a.entry_time).localeCompare(String(b.observation_time ?? b.entry_time)))) {
    const when = formatWhen(report.observation_time ?? report.entry_time, "unknown time");
    lines.push(`--- ${when} (entered ${formatWhen(report.entry_time, "unknown")}) ---`);
    lines.push("Subjective (caregiver observations):");
    if (report.observations.length === 0) {
      lines.push("- none recorded");
    } else {
      for (const obs of report.observations) {
        const neg = obs.negated ? "No " : "";
        const where = obs.body_location ? ` (${obs.body_location})` : "";
        lines.push(`- [${categoryLabel(obs.category)}] ${neg}${obs.text}${where}`);
      }
    }
    lines.push("Objective (measurements):");
    if (report.measurements.length === 0) {
      lines.push("- none recorded");
    } else {
      for (const m of report.measurements) {
        lines.push(`- ${measurementLabel(m.type)}: ${measurementValueText(m.type, m.systolic, m.diastolic, m.value)} ${m.unit ?? "(unit unknown)"} — "${m.source_text}"`);
      }
    }
    if (report.original_transcript) lines.push(`Caregiver's own words: "${report.original_transcript}"`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function buildFamilyText(reports: ReportRecord[], patientName: string): string {
  if (reports.length === 0) return `No saved observations for ${patientName} yet.`;
  const lines: string[] = [`What was noticed for ${patientName}:`, ""];
  for (const report of [...reports].sort((a, b) => String(a.observation_time ?? a.entry_time).localeCompare(String(b.observation_time ?? b.entry_time)))) {
    const when = formatWhen(report.observation_time ?? report.entry_time, "recently");
    const parts: string[] = [];
    for (const m of report.measurements) {
      parts.push(`${measurementLabel(m.type)} was ${measurementValueText(m.type, m.systolic, m.diastolic, m.value)}${m.unit ? ` ${m.unit}` : ""}`);
    }
    for (const obs of report.observations) {
      const neg = obs.negated ? "There was no " : "There was ";
      parts.push(`${neg}${obs.text.toLowerCase()}${obs.body_location ? ` (${obs.body_location})` : ""}`);
    }
    lines.push(`- ${when}: ${parts.length > 0 ? parts.join("; ") + "." : "nothing specific recorded."}`);
  }
  lines.push("", EXPORT_DISCLAIMER);
  return lines.join("\n");
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildReportsCSV(reports: ReportRecord[]): string {
  const header = ["report_id", "patient", "observation_time", "entry_time", "kind", "type", "value", "unit", "negated", "source_text"];
  const rows: string[][] = [header];
  for (const report of reports) {
    const obsTime = report.observation_time ?? "";
    for (const m of report.measurements) {
      rows.push([
        report.id,
        report.patient_name,
        obsTime,
        report.entry_time,
        "measurement",
        m.type,
        measurementValueText(m.type, m.systolic, m.diastolic, m.value),
        m.unit ?? "",
        "",
        m.source_text,
      ]);
    }
    for (const obs of report.observations) {
      rows.push([
        report.id,
        report.patient_name,
        obsTime,
        report.entry_time,
        "observation",
        obs.category,
        obs.text,
        "",
        obs.negated ? "yes" : "no",
        obs.source_text,
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function buildReportsJSON(reports: ReportRecord[]): string {
  return JSON.stringify({ disclaimer: EXPORT_DISCLAIMER, reports }, null, 2);
}
