"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Download, FileText, LoaderCircle, Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ReportSummary = {
  id: string;
  patient_id: string;
  patient_name: string;
  observation_time: string | null;
  entry_time: string;
  saved_at: string;
  measurements: Measurement[];
  observations: Observation[];
};

type Measurement = {
  type: string;
  value: number | string | { systolic: number; diastolic: number };
  unit: string | null;
  confidence: number;
  source_text: string;
};

type Observation = { type: string; description: string; confidence: number; source_text: string };

type Report = ReportSummary & {
  draft_id: string;
  confirmed_revision: number;
  confirmation_method: "button" | "voice";
  confirmed_at: string;
  observation_time_precision: string;
  observation_time_source: string | null;
  original_transcript: string;
};

function apiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object" &&
    "message" in payload.error && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

function valueText(measurement: Measurement): string {
  if (typeof measurement.value === "object" && measurement.value !== null) {
    return `${measurement.value.systolic} / ${measurement.value.diastolic}`;
  }
  return String(measurement.value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function csvFor(report: Report): string {
  const rows: string[][] = [["kind", "type", "value", "unit", "description", "source_text", "confidence"]];
  for (const measurement of report.measurements) {
    rows.push(["measurement", measurement.type, valueText(measurement), measurement.unit ?? "", "", measurement.source_text, String(measurement.confidence)]);
  }
  for (const observation of report.observations) {
    rows.push(["observation", observation.type, "", "", observation.description, observation.source_text, String(observation.confidence)]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function downloadFile(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.style.display = "none";
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    blood_pressure: "Blood pressure",
    blood_glucose: "Blood glucose",
    temperature: "Temperature",
    heart_rate: "Heart rate",
    spo2: "Oxygen saturation",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function familyLabel(type: string): string {
  const labels: Record<string, string> = {
    blood_pressure: "blood pressure",
    blood_glucose: "blood sugar",
    temperature: "body temperature",
    heart_rate: "pulse",
    spo2: "oxygen level",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function doctorText(report: Report): string {
  const when = report.observation_time ? new Date(report.observation_time).toLocaleString() : "Time not recorded";
  const measurements = report.measurements.length
    ? ["| Measurement | Value | Unit |", "| --- | --- | --- |", ...report.measurements.map((item) => `| ${typeLabel(item.type)} | ${valueText(item)} | ${item.unit ?? ""} |`)].join("\n")
    : "No measurements recorded";
  const observations = report.observations.length
    ? report.observations.map((item) => `- ${item.description}`).join("\n")
    : "- No observations recorded";
  return [
    "VOICECARE — DOCTOR SUMMARY",
    `Patient: ${report.patient_name}`,
    `Observed: ${when}${report.observation_time_precision ? ` (${report.observation_time_precision})` : ""}`,
    "",
    "Measurements",
    measurements,
    "",
    "Observations",
    observations,
    "",
    `Saved: ${new Date(report.saved_at).toLocaleString()}`,
    "This is a caregiver-recorded summary, not a diagnosis.",
  ].join("\n");
}

function familyText(report: Report): string {
  const when = report.observation_time ? ` around ${new Date(report.observation_time).toLocaleString()}` : "";
  const readings = report.measurements.map((item) => `${familyLabel(item.type)} was ${valueText(item)}${item.unit ? ` ${item.unit}` : ""}`);
  const notes = report.observations.map((item) => item.description.trim()).filter(Boolean);
  const details = [...readings, ...notes].join(". ");
  return `${report.patient_name}'s update${when}: ${details || "No measurements or observations were recorded"}.`;
}

export function ReportHistory({ patientId, onSelect }: { patientId: string | null; onSelect: (id: string) => void }) {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!patientId) { setReports([]); setLoading(false); return; }
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/reports?patient_id=${encodeURIComponent(patientId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(apiError(payload, "Could not load report history."));
        if (active) setReports(payload.reports as ReportSummary[]);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load report history.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [patientId]);

  if (loading) return <Card className="mt-3"><CardContent className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden />Loading saved reports...</CardContent></Card>;
  if (error) return <Card className="mt-3"><CardContent className="py-5 text-sm text-destructive">{error}</CardContent></Card>;
  if (!reports.length) return (
    <Card className="mt-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><FileText className="size-4" aria-hidden />No saved reports yet</CardTitle>
        <CardDescription>Confirmed reports for this person will appear here, newest first.</CardDescription>
      </CardHeader>
    </Card>
  );
  return <div className="mt-3 space-y-2">
    {reports.map((report) => (
      <button type="button" key={report.id} onClick={() => onSelect(report.id)} className="w-full text-left">
        <Card className="transition-colors hover:bg-muted/50">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">{report.observation_time ? new Date(report.observation_time).toLocaleString() : `Entered ${new Date(report.entry_time).toLocaleDateString()}`}</p>
              <p className="mt-1 text-sm text-muted-foreground">{report.measurements.length} measurement{report.measurements.length === 1 ? "" : "s"} · {report.observations.length} note{report.observations.length === 1 ? "" : "s"}</p>
            </div>
            <Badge variant="secondary">Saved</Badge>
          </CardContent>
        </Card>
      </button>
    ))}
  </div>;
}

export function ReportDetailScreen({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(apiError(payload, "Could not load this saved report."));
        if (active) setReport(payload.report as Report);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load this saved report.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [reportId]);

  if (loading) return <main className="mx-auto flex min-h-dvh max-w-2xl items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><LoaderCircle className="size-5 animate-spin" aria-hidden />Opening saved report...</main>;
  if (error || !report) return <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"><p className="text-sm text-destructive">{error ?? "Report unavailable."}</p><Button variant="outline" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden />History</Button></main>;

  const jsonData = {
    report_id: report.id,
    patient: report.patient_name,
    observation_time: report.observation_time,
    measurements: report.measurements,
    observations: report.observations,
  };
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden />History</Button>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => downloadFile(`voicecare-${report.id}-doctor.txt`, doctorText(report), "text/plain;charset=utf-8")}><Download data-icon="inline-start" aria-hidden />Doctor summary</Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`voicecare-${report.id}-family.txt`, familyText(report), "text/plain;charset=utf-8")}><Download data-icon="inline-start" aria-hidden />Family summary</Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`voicecare-${report.id}.json`, `${JSON.stringify(JSON.parse(stableJson(jsonData)), null, 2)}\n`, "application/json;charset=utf-8")}><Download data-icon="inline-start" aria-hidden />JSON</Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`voicecare-${report.id}.csv`, `${csvFor(report)}\r\n`, "text/csv;charset=utf-8")}><Download data-icon="inline-start" aria-hidden />CSV</Button>
          <Button size="sm" onClick={() => window.print()}><Printer data-icon="inline-start" aria-hidden />Print</Button>
        </div>
      </header>

      <article id="print-summary" className="mt-5 space-y-5">
        <section>
          <Badge variant="secondary">Confirmed report · revision {report.confirmed_revision}</Badge>
          <h1 className="mt-3 text-2xl font-semibold">Care update for {report.patient_name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Observed {report.observation_time ? new Date(report.observation_time).toLocaleString() : "time not recorded"}</p>
        </section>

        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Measurements</h2>
          {report.measurements.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {report.measurements.map((measurement, index) => <Card key={`${measurement.type}-${index}`}><CardHeader className="pb-2"><CardTitle className="text-sm">{typeLabel(measurement.type)}</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold tabular-nums">{valueText(measurement)}{measurement.unit && <span className="ml-2 text-sm font-normal text-muted-foreground">{measurement.unit}</span>}</p><p className="mt-2 text-xs text-muted-foreground">Source: {measurement.source_text}</p></CardContent></Card>)}
          </div> : <Card className="mt-3"><CardContent className="py-4 text-sm text-muted-foreground">No measurements recorded.</CardContent></Card>}
        </section>

        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Observations</h2>
          {report.observations.length ? <div className="mt-3 space-y-2">{report.observations.map((observation, index) => <Card key={`${observation.type}-${index}`}><CardContent className="py-4"><p className="text-sm">{observation.description}</p><p className="mt-1 text-xs text-muted-foreground">{observation.type}</p></CardContent></Card>)}</div> : <Card className="mt-3"><CardContent className="py-4 text-sm text-muted-foreground">No observations recorded.</CardContent></Card>}
        </section>

        <details className="print:hidden"><summary className="cursor-pointer text-sm font-medium">Original transcript</summary><p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{report.original_transcript}</p></details>
        <p className="text-xs text-muted-foreground">Confirmed {new Date(report.confirmed_at).toLocaleString()} · saved {new Date(report.saved_at).toLocaleString()}. This caregiver-recorded report is not a diagnosis.</p>
      </article>
    </main>
  );
}
