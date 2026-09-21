// VoiceCare hackathon demo: one continuous caregiver story on a single page.
//
// Speak (or type when the microphone is unavailable) → answer the blocking questions →
// review the readback → confirm and save → see the report once in history → open the
// printable appointment summary. Every step works without registration: the server-issued
// anonymous demo session scopes all data to this browser.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapResponse,
  DraftIssue,
  DraftRecord,
  ExpressionRecord,
  HealthResponse,
  Measurement,
  ReportRecord,
} from "@voicecare/shared";
import { useVoiceSession } from "@/hooks/use-voice";

type LoadState = "preparing" | "ready" | "failed";

const EXAMPLE_SENTENCE =
  "I checked Rosa this morning. Her pressure was 138 over 88, her sugar was 6.2, temperature 37.4, and her left knee was hurting.";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = (await response.json()) as T & { error?: { code?: string; message?: string }; draft?: DraftRecord | null };
  if (!response.ok) {
    const err = new Error(payload?.error?.message ?? `Request failed (${response.status}).`) as Error & {
      draft?: DraftRecord | null;
      code?: string;
    };
    err.draft = payload?.draft ?? null;
    err.code = payload?.error?.code;
    throw err;
  }
  return payload;
}

function measurementText(item: Measurement): string {
  if (item.type === "blood_pressure") return `${item.systolic ?? "?"} over ${item.diastolic ?? "?"}`;
  return item.value === null || item.value === undefined ? "?" : String(item.value);
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reportTime(report: ReportRecord): string {
  return new Date(report.observation_time ?? report.entry_time).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function dateBoundary(value: string, endOfDay = false): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).toISOString();
}

function BlockingQuestion({ issue, onAnswer }: { issue: DraftIssue; onAnswer: (issue: DraftIssue, answer: string) => void }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
      <p className="text-sm font-semibold text-amber-950">{issue.question}</p>
      {issue.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {issue.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onAnswer(issue, option)}
              className="rounded-full border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 transition hover:border-amber-500 hover:bg-amber-100"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {issue.code === "expression_permission" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onAnswer(issue, "__remember__")}
            className="rounded-full bg-amber-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-900"
          >
            Yes, remember it
          </button>
          <button
            type="button"
            onClick={() => onAnswer(issue, "__forget__")}
            className="rounded-full border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 transition hover:bg-amber-100"
          >
            No, just this once
          </button>
        </div>
      )}
    </div>
  );
}

export default function DemoApp() {
  const [loadState, setLoadState] = useState<LoadState>("preparing");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportRecord | null>(null);
  const [expressions, setExpressions] = useState<ExpressionRecord[]>([]);
  const [typedText, setTypedText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveKey, setSaveKey] = useState<string | null>(null);
  const [summaryFrom, setSummaryFrom] = useState("");
  const [summaryTo, setSummaryTo] = useState("");
  const [summary, setSummary] = useState<ReportRecord[] | null>(null);
  const saveKeyRevisionRef = useRef<number | null>(null);

  const patient = bootstrap?.patients[0] ?? null;

  const refreshDraft = useCallback(async () => {
    if (!draft) return;
    try {
      setDraft(await api<DraftRecord>(`/api/drafts/${draft.id}`));
    } catch {
      // The draft panel keeps its last good state; the next action surfaces the error.
    }
  }, [draft]);

  const voice = useVoiceSession({
    patientId: patient?.id ?? null,
    getDraft: () => (draft ? { id: draft.id, revision: draft.revision } : null),
    onDraftChanged: () => {
      void refreshDraft();
    },
  });

  const loadAll = useCallback(async () => {
    setLoadState("preparing");
    setLoadError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const data = await api<BootstrapResponse>(`/api/bootstrap?timezone=${encodeURIComponent(timezone)}`);
      setBootstrap(data);
      setDraft(data.current_draft);
      setExpressions(data.expressions);
      const patientId = data.patients[0]?.id;
      if (patientId) {
        setReports(await api<ReportRecord[]>(`/api/reports?patient_id=${encodeURIComponent(patientId)}`));
      }
      try {
        setHealth(await api<HealthResponse>("/api/health"));
      } catch {
        // Health is advisory; the bootstrap already proved the database answers.
      }
      setLoadState("ready");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The demo could not start.");
      setLoadState("failed");
    }
  }, []);

  // Initial demo bootstrap on mount. The retry button reuses loadAll from an event handler.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount only
    void loadAll();
  }, [loadAll]);

  async function ensureDraft(): Promise<DraftRecord> {
    if (draft) return draft;
    if (!patient) throw new Error("The demo session is still loading.");
    const created = await api<DraftRecord>("/api/drafts", {
      method: "POST",
      body: JSON.stringify({ patient_id: patient.id }),
    });
    setDraft(created);
    return created;
  }

  async function submitTyped() {
    const text = typedText.trim();
    if (!text || busy) return;
    setBusy("typing");
    setNotice(null);
    try {
      const current = await ensureDraft();
      const updated = await api<DraftRecord>(`/api/drafts/${current.id}/text`, {
        method: "POST",
        body: JSON.stringify({ expected_revision: current.revision, text }),
      });
      setDraft(updated);
      setTypedText("");
    } catch (err) {
      if (err instanceof Error && "draft" in err && (err as { draft?: DraftRecord | null }).draft) {
        setDraft((err as { draft: DraftRecord }).draft);
      }
      setNotice(err instanceof Error ? err.message : "The observation could not be added.");
    } finally {
      setBusy(null);
    }
  }

  async function answerIssue(issue: DraftIssue, answer: string) {
    if (!draft || busy) return;
    setBusy("answering");
    setNotice(null);
    try {
      if (issue.code === "expression_permission" && (answer === "__remember__" || answer === "__forget__")) {
        if (answer === "__remember__" && issue.phrase && issue.measurement_type) {
          await api("/api/expressions", {
            method: "POST",
            body: JSON.stringify({
              phrase: issue.phrase,
              measurement_type: issue.measurement_type,
              unit: issue.unit ?? null,
              patient_specific: issue.patient_specific ?? true,
              approved: true,
              approved_via: "button",
            }),
          }).catch((err: unknown) => {
            if (!(err instanceof Error && (err as { code?: string }).code === "expression_exists")) throw err;
          });
          const list = await api<ExpressionRecord[]>(`/api/expressions?patient_id=${encodeURIComponent(draft.patient_id)}`);
          setExpressions(list);
        }
        const updated = await api<DraftRecord>(`/api/drafts/${draft.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            expected_revision: draft.revision,
            reason: "clarification_answer",
            resolve_issue_ids: [issue.id],
          }),
        });
        setDraft(updated);
        return;
      }
      // A tapped unit option updates the referenced measurement in place, keeping the
      // spoken values. Value, time, and subject questions are answered by voice or typing.
      const measurement = draft.measurements.find((item) => item.id === issue.target_id);
      const patch =
        measurement && issue.target === "measurement"
          ? {
              measurements: [
                {
                  id: measurement.id,
                  type: measurement.type,
                  systolic: measurement.systolic ?? undefined,
                  diastolic: measurement.diastolic ?? undefined,
                  value: measurement.value ?? undefined,
                  unit: answer,
                  source_text: measurement.source_text,
                },
              ],
            }
          : {};
      const updated = await api<DraftRecord>(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expected_revision: draft.revision, reason: "clarification_answer", ...patch }),
      });
      setDraft(updated);
    } catch (err) {
      if (err instanceof Error && "draft" in err && (err as { draft?: DraftRecord | null }).draft) {
        setDraft((err as { draft: DraftRecord }).draft);
      }
      setNotice(err instanceof Error ? err.message : "The answer could not be applied.");
    } finally {
      setBusy(null);
    }
  }

  async function removeItem(kind: "measurement" | "observation", id: string) {
    if (!draft || busy) return;
    setBusy("editing");
    try {
      const updated = await api<DraftRecord>(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expected_revision: draft.revision,
          reason: "caregiver_correction",
          ...(kind === "measurement" ? { remove_measurement_ids: [id] } : { remove_observation_ids: [id] }),
        }),
      });
      setDraft(updated);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The item could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmAndSave(retry = false) {
    if (!draft || busy) return;
    setBusy("saving");
    setNotice(null);
    try {
      const confirmed = retry && draft.status === "CONFIRMED" ? draft : await api<DraftRecord>(`/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ expected_revision: draft.revision, method: "button" }),
      });
      let key = saveKey;
      if (saveKeyRevisionRef.current !== confirmed.revision || !key) {
        key = crypto.randomUUID();
        saveKeyRevisionRef.current = confirmed.revision;
        setSaveKey(key);
      }
      const saved = await api<{ report: ReportRecord; reused: boolean }>(`/api/drafts/${draft.id}/save`, {
        method: "POST",
        body: JSON.stringify({
          expected_revision: confirmed.revision,
          confirmed_revision: confirmed.confirmed_revision ?? confirmed.revision,
          idempotency_key: key,
        }),
      });
      setDraft(await api<DraftRecord>(`/api/drafts/${draft.id}`));
      if (patient) setReports(await api<ReportRecord[]>(`/api/reports?patient_id=${encodeURIComponent(patient.id)}`));
      setNotice(saved.reused ? "That report was already saved — no duplicate was created." : "Saved. The report now appears once in history.");
    } catch (err) {
      if (err instanceof Error && "draft" in err && (err as { draft?: DraftRecord | null }).draft) {
        setDraft((err as { draft: DraftRecord }).draft);
      }
      setNotice(err instanceof Error ? err.message : "The report could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function startNewReport() {
    if (!patient || busy) return;
    setBusy("new");
    try {
      const created = await api<DraftRecord>("/api/drafts", {
        method: "POST",
        body: JSON.stringify({ patient_id: patient.id }),
      });
      setDraft(created);
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "A new report could not be started.");
    } finally {
      setBusy(null);
    }
  }

  async function openReport(id: string) {
    try {
      setSelectedReport(await api<ReportRecord>(`/api/reports/${id}`));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The report could not be opened.");
    }
  }

  async function loadSummary() {
    if (!patient) return;
    const params = new URLSearchParams({ patient_id: patient.id });
    if (summaryFrom) params.set("from", dateBoundary(summaryFrom));
    if (summaryTo) params.set("to", dateBoundary(summaryTo, true));
    try {
      const payload = await api<{ reports: ReportRecord[] }> (`/api/reports/summary?${params.toString()}`);
      setSummary(payload.reports);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The summary could not be loaded.");
    }
  }

  async function resetDemo() {
    if (busy) return;
    if (!window.confirm("Reset the demo? This abandons the current fictional workspace and starts a clean one.")) return;
    setBusy("reset");
    try {
      voice.stop();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const data = await api<BootstrapResponse>("/api/reset", {
        method: "POST",
        body: JSON.stringify({ timezone }),
      });
      setBootstrap(data);
      setDraft(data.current_draft);
      setExpressions(data.expressions);
      setReports([]);
      setSelectedReport(null);
      setSummary(null);
      setTypedText("");
      setSaveKey(null);
      saveKeyRevisionRef.current = null;
      setNotice("Demo reset. This is a clean fictional workspace.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The demo could not be reset.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteExpression(id: string) {
    try {
      await api(`/api/expressions/${id}`, { method: "DELETE" });
      setExpressions((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The expression could not be deleted.");
    }
  }

  if (loadState === "preparing") {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-emerald-100 bg-white/90 p-8 text-center shadow-xl shadow-emerald-950/5">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-emerald-700 text-xl font-black text-white">V</div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">VoiceCare</h1>
          <p className="mt-2 text-sm text-slate-500" role="status">Preparing your private demo workspace...</p>
          <div className="mx-auto mt-5 h-1.5 w-28 overflow-hidden rounded-full bg-emerald-100"><div className="h-full w-2/3 rounded-full bg-emerald-600" /></div>
        </div>
      </main>
    );
  }

  if (loadState === "failed") {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <div className="w-full max-w-lg rounded-3xl border border-rose-100 bg-white p-8 shadow-xl shadow-slate-900/5">
        <div className="grid size-12 place-items-center rounded-2xl bg-rose-100 text-xl font-bold text-rose-700">!</div>
        <h1 className="mt-4 text-2xl font-bold">We could not start VoiceCare</h1>
        <p className="mt-3 rounded-2xl bg-rose-50 p-4 text-sm text-rose-900" role="alert">
          {loadError ?? "The demo could not start."}
        </p>
        <button
          type="button"
          onClick={() => void loadAll()}
          className="mt-5 rounded-full bg-emerald-700 px-6 py-3 font-semibold text-white transition hover:bg-emerald-800"
        >
          Try again
        </button>
        </div>
      </main>
    );
  }

  const blocking = draft?.unresolved_issues.filter((issue) => issue.blocking) ?? [];
  const canConfirm = !!draft && draft.status !== "CONFIRMED" && draft.status !== "SAVED" && blocking.length === 0 &&
    (draft.measurements.length > 0 || draft.observations.length > 0);
  const voiceActive = voice.status !== "idle" && voice.status !== "error";

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-white/80 bg-white/80 px-5 py-4 shadow-sm backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-emerald-700 text-lg font-black text-white">V</div>
          <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-950">VoiceCare</h1>
          <p className="text-xs text-slate-500">
            {health?.database === "ready" || !health ? (
              <span role="status">Care notes, simply spoken</span>
            ) : (
              <span role="status">The demo database is waking up...</span>
            )}
          </p>
        </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800"><span className="size-2 rounded-full bg-emerald-500" />Demo ready</span>
        {patient && <span className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">Caring for {patient.display_name}</span>}
        <button
          type="button"
          onClick={() => void resetDemo()}
          disabled={busy !== null}
          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
        >
          Reset demo
        </button>
        </div>
      </header>

      <section className="px-1 pb-6 pt-9 sm:px-2" aria-labelledby="page-title">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Today&apos;s care note</p>
        <h2 id="page-title" className="mt-2 max-w-3xl text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">How is {patient?.display_name ?? "your loved one"} doing today?</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">Speak naturally or type what you noticed. VoiceCare turns it into a clear report that you review before anything is saved.</p>
        <ol className="mt-6 grid max-w-3xl grid-cols-2 gap-2 text-xs font-semibold sm:grid-cols-4">
          {["Tell us", "Review", "Save", "Share"].map((step, index) => <li key={step} className={`rounded-full px-3 py-2 text-center ${index < 2 ? "bg-emerald-100 text-emerald-800" : "bg-white/70 text-slate-500"}`}><span className="mr-1.5">{index + 1}</span>{step}</li>)}
        </ol>
      </section>

      <section aria-label="Prototype notice" className="mb-4 rounded-2xl border border-amber-200/80 bg-amber-50/80 p-4 text-sm leading-5 text-amber-950">
        <p>
          <strong>Fictional demo information only.</strong> This prototype records caregiver observations; it does not give medical advice or replace a clinician.
        </p>
      </section>

      {notice && (
        <p role="status" className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm font-medium text-sky-950">
          {notice}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="Speak or type" className="rounded-3xl border border-emerald-100 bg-white p-5 shadow-xl shadow-emerald-950/5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Step 1 · Tell us</p>
          <h2 className="mt-2 text-2xl font-bold text-slate-950">Record an observation</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Before requesting the microphone, the app explains why: your voice is transcribed to build the care
            report below. Or type the same observation — it follows the identical flow.
          </p>
          <p className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-950"><span className="font-bold">Try saying:</span> “{EXAMPLE_SENTENCE}”</p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {!voiceActive ? (
              <button
                type="button"
                onClick={() => {
                  void ensureDraft()
                    .then(() => voice.start())
                    .catch((err: unknown) => setNotice(err instanceof Error ? err.message : "Voice could not start."));
                }}
                className="rounded-full bg-emerald-700 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-emerald-800/15 transition hover:bg-emerald-800"
              >
                Speak
              </button>
            ) : (
              <button
                type="button"
                onClick={voice.stop}
                className="voice-pulse rounded-full bg-rose-600 px-8 py-4 text-lg font-bold text-white hover:bg-rose-700"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void startNewReport()}
              disabled={busy !== null}
              className="rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              New report
            </button>
          </div>
          <p className="mt-3 text-sm font-medium text-slate-600" role="status">
            Voice: {voice.status === "idle" ? "off" : voice.status.replace("-", " ")}
            {voice.status === "ready" && " — start speaking."}
          </p>
          {voice.error && (
            <p role="alert" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              {voice.error}
            </p>
          )}
          {voice.lines.length > 0 && (
            <ul aria-label="Conversation" className="mt-3 max-h-40 space-y-2 overflow-auto rounded-2xl bg-slate-50 p-3 text-sm">
              {voice.lines.map((line, index) => (
                <li key={index}>
                  <strong>{line.speaker === "you" ? "You" : "VoiceCare"}:</strong> {line.text}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex items-center gap-3"><span className="h-px flex-1 bg-slate-200" /><span className="text-xs font-semibold uppercase tracking-wider text-slate-400">or type instead</span><span className="h-px flex-1 bg-slate-200" /></div>
          <label htmlFor="typed-observation" className="sr-only">
            Type an observation instead
          </label>
          <textarea
            id="typed-observation"
            value={typedText}
            onChange={(event) => setTypedText(event.target.value)}
            rows={3}
            placeholder="For example: Her pressure was 138 over 88..."
            className="mt-4 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white"
          />
          <button
            type="button"
            onClick={() => void submitTyped()}
            disabled={busy !== null || typedText.trim().length === 0}
            className="mt-3 rounded-full bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "typing" ? "Adding..." : "Add to report"}
          </button>
        </section>

        <section aria-label="Review and confirm" className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xl shadow-slate-900/5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Step 2 · Review</p>
          <h2 className="mt-2 text-2xl font-bold text-slate-950">Your report draft</h2>
          {!draft || (draft.measurements.length === 0 && draft.observations.length === 0 && !draft.transcript) ? (
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-5 py-10 text-center"><div className="mx-auto grid size-11 place-items-center rounded-full bg-white text-xl text-slate-400 shadow-sm">+</div><p className="mt-3 font-semibold text-slate-700">Your draft will appear here</p><p className="mt-1 text-sm text-slate-500">Speak or type an observation to begin.</p></div>
          ) : (
            <>
              <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Revision {draft.revision} · {humanize(draft.status)}
                {draft.current_report_id ? " · Saved" : ""}
              </p>
              <p aria-label="Readback" className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 text-sm font-medium leading-6 text-emerald-950">
                {draft.readback}
              </p>
              {blocking.length > 0 && (
                <div className="mt-3 space-y-2">
                  {blocking.map((issue) => (
                    <BlockingQuestion key={issue.id} issue={issue} onAnswer={(item, answer) => void answerIssue(item, answer)} />
                  ))}
                  <p className="text-sm text-zinc-600">Answer by voice, by tapping an option, or by typing below.</p>
                </div>
              )}
              {draft.measurements.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {draft.measurements.map((item) => (
                    <li
                      key={item.id}
                      className={`flex items-start justify-between gap-3 rounded-2xl border p-3 ${item.resolution_status !== "resolved" ? "border-amber-200 bg-amber-50" : "border-slate-100 bg-slate-50/70"}`}
                    >
                      <div>
                        <p className="font-semibold">
                          {humanize(item.type)}: {measurementText(item)}{" "}
                          {item.unit ?? <span className="text-amber-700">(unit needed)</span>}
                        </p>
                        <p className="mt-1 text-xs leading-4 text-slate-500">“{item.source_text}”{item.warning ? ` · ${item.warning}` : ""}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void removeItem("measurement", item.id)}
                        aria-label={`Remove ${item.type} measurement`}
                        className="rounded-full px-2 py-1 text-xs font-semibold text-slate-400 hover:bg-white hover:text-rose-600"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {draft.observations.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {draft.observations.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
                      <div>
                        <p className="font-semibold">
                          {item.negated ? "No " : ""}{item.text}
                        </p>
                        <p className="text-xs text-zinc-600">
                          {humanize(item.category)} · “{item.source_text}”
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void removeItem("observation", item.id)}
                        aria-label={`Remove observation ${item.text}`}
                        className="rounded-full px-2 py-1 text-xs font-semibold text-slate-400 hover:bg-white hover:text-rose-600"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void confirmAndSave()}
                  disabled={busy !== null || (!canConfirm && draft.status !== "CONFIRMED")}
                  className="w-full rounded-full bg-slate-900 px-8 py-4 text-lg font-bold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {busy === "saving" ? "Saving..." : draft.status === "SAVED" ? "Report saved" : "Confirm and save report"}
                </button>
                {draft.status === "CONFIRMED" && (
                  <button
                    type="button"
                    onClick={() => void confirmAndSave(true)}
                    disabled={busy !== null}
                    className="rounded-full border border-zinc-400 px-5 py-2.5 font-semibold hover:bg-zinc-100 disabled:opacity-50"
                  >
                    Retry save
                  </button>
                )}
              </div>
              {!canConfirm && draft.status !== "CONFIRMED" && draft.status !== "SAVED" && (
                <p className="mt-1 text-sm text-zinc-600">
                  {blocking.length > 0 ? "Answer the questions above before confirming." : "Add at least one measurement or observation."}
                </p>
              )}
            </>
          )}
        </section>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section aria-label="History" className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Step 3 · Saved</p>
          <h2 className="mt-2 text-xl font-bold text-slate-950">Report history</h2>
          {reports.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-600">Confirmed reports appear here, newest first.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {reports.map((report) => (
                <li key={report.id}>
                  <button
                    type="button"
                    onClick={() => void openReport(report.id)}
                    className="w-full rounded-2xl border border-slate-100 p-4 text-left transition hover:border-emerald-200 hover:bg-emerald-50/40"
                  >
                    <span className="font-semibold">
                      {reportTime(report)}
                    </span>
                    <span className="block text-sm text-zinc-600">
                      {report.measurements.map((m) => `${humanize(m.type)} ${measurementText(m)} ${m.unit ?? ""}`).join(" · ")}
                      {report.observations.length > 0 ? ` · ${report.observations.map((o) => o.text).join("; ")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selectedReport && (
            <div className="mt-3 rounded-lg border border-zinc-300 p-3">
              <h3 className="font-bold">Report detail</h3>
              <p className="text-sm text-zinc-600">Original wording: “{selectedReport.original_transcript}”</p>
              <ul className="mt-1 text-sm">
                {selectedReport.measurements.map((m) => (
                  <li key={m.id}>
                    {m.type.replace(/_/g, " ")}: {measurementText(m)} {m.unit ?? "(unit unknown)"}
                  </li>
                ))}
                {selectedReport.observations.map((o) => (
                  <li key={o.id}>
                    {o.negated ? "No " : ""}{o.text}
                  </li>
                ))}
              </ul>
              {selectedReport.supersedes_report_id && (
                <button type="button" onClick={() => void openReport(selectedReport.supersedes_report_id!)} className="mt-1 text-sm underline">
                  Open the earlier revision this replaced
                </button>
              )}
              {selectedReport.superseded_by_report_id && (
                <button type="button" onClick={() => void openReport(selectedReport.superseded_by_report_id!)} className="mt-1 block text-sm underline">
                  Open the newer revision
                </button>
              )}
              <button type="button" onClick={() => setSelectedReport(null)} className="mt-2 rounded border px-3 py-1 text-sm">
                Close
              </button>
            </div>
          )}
        </section>

        <div className="space-y-4">
          <section aria-label="Appointment summary" className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Step 4 · Share</p>
            <h2 className="mt-2 text-xl font-bold text-slate-950">Appointment summary</h2>
            <p className="mt-1 text-sm text-slate-500">Choose a date range, then print a clean summary for a visit.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <label className="text-sm">
                From <input type="date" value={summaryFrom} onChange={(e) => setSummaryFrom(e.target.value)} className="rounded border p-1" />
              </label>
              <label className="text-sm">
                To <input type="date" value={summaryTo} onChange={(e) => setSummaryTo(e.target.value)} className="rounded border p-1" />
              </label>
              <button type="button" onClick={() => void loadSummary()} className="rounded-full border border-slate-200 px-4 py-1.5 font-semibold hover:bg-slate-50">
                Load
              </button>
              {summary && summary.length > 0 && (
                <button type="button" onClick={() => window.print()} className="rounded-full bg-emerald-700 px-4 py-1.5 font-semibold text-white hover:bg-emerald-800">
                  Print
                </button>
              )}
            </div>
            {summary && (
              <div className="mt-2 rounded bg-white p-2 text-sm" id="print-summary">
                <p className="font-semibold">Caregiver-reported observations. Review before making medical decisions.</p>
                {summary.length === 0 ? (
                  <p>No reports in this range.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {summary.map((report) => (
                      <li key={report.id}>
                        <strong>
                          {report.observation_time ? new Date(report.observation_time).toLocaleString() : new Date(report.entry_time).toLocaleString()}:
                        </strong>{" "}
                        {report.measurements.map((m) => `${m.type.replace(/_/g, " ")} ${measurementText(m)} ${m.unit ?? ""}`).join("; ")}
                        {report.observations.length > 0 && `; ${report.observations.map((o) => `${o.negated ? "no " : ""}${o.text}`).join("; ")}`}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section aria-label="Remembered expressions" className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-bold text-slate-950">Remembered expressions</h2>
            <p className="mt-1 text-sm text-slate-500">Personal phrases VoiceCare learned with your permission.</p>
            {expressions.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-600">None yet. Clarify a personal phrase by voice and approve remembering it.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {expressions.map((expression) => (
                  <li key={expression.id} className="flex items-center justify-between gap-2 rounded border p-2">
                    <span>
                      “{expression.phrase}” → {expression.measurement_type.replace(/_/g, " ")}{expression.unit ? ` (${expression.unit})` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteExpression(expression.id)}
                      aria-label={`Forget expression ${expression.phrase}`}
                      className="rounded border px-2 py-1 hover:bg-zinc-100"
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <footer className="py-8 text-center text-xs text-slate-400">VoiceCare hackathon prototype · Fictional data only</footer>
    </main>
  );
}
