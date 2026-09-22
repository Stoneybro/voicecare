// VoiceCare hackathon demo: a deliberately minimal home screen.
//
// Home shows a prominent Speak button, a History button, a Reset button, and one live
// conversation space. The voice agent asks its questions out loud; unit options also appear
// as tappable answers for typed-only judges. When the draft is reviewable, a single confirm
// card appears. History lives one tap away. No grids, no panels, no form-filling.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapResponse,
  DraftIssue,
  DraftRecord,
  ExpressionRecord,
  ReportRecord,
} from "@voicecare/shared";
import { useVoiceSession } from "@/hooks/use-voice";

type LoadState = "preparing" | "ready" | "failed";
type View = "home" | "history";

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

function measurementText(type: string, systolic: number | null, diastolic: number | null, value: number | null): string {
  if (type === "blood_pressure") return `${systolic ?? "?"} over ${diastolic ?? "?"}`;
  return value === null || value === undefined ? "?" : String(value);
}

export default function DemoApp() {
  const [loadState, setLoadState] = useState<LoadState>("preparing");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("home");
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportRecord | null>(null);
  const [expressions, setExpressions] = useState<ExpressionRecord[]>([]);
  const [typedOpen, setTypedOpen] = useState(false);
  const [typedText, setTypedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveKey, setSaveKey] = useState<string | null>(null);
  const [summaryFrom, setSummaryFrom] = useState("");
  const [summaryTo, setSummaryTo] = useState("");
  const [summary, setSummary] = useState<ReportRecord[] | null>(null);
  const saveKeyRevisionRef = useRef<number | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  const patient = bootstrap?.patients[0] ?? null;

  const voice = useVoiceSession({
    patientId: patient?.id ?? null,
    getDraft: () => (draft ? { id: draft.id, revision: draft.revision } : null),
    onDraftChanged: () => {
      setDraft((current) => {
        if (!current) return current;
        void api<DraftRecord>(`/api/drafts/${current.id}`).then(setDraft).catch(() => undefined);
        return current;
      });
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
      setLoadState("ready");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The demo could not start.");
      setLoadState("failed");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount only
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const el = conversationRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [voice.lines, voice.liveUser, voice.liveAgent, draft?.readback]);

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

  function handleVoiceError(err: unknown): string {
    if (err instanceof Error && "draft" in err && (err as { draft?: DraftRecord | null }).draft) {
      setDraft((err as { draft: DraftRecord }).draft);
    }
    return err instanceof Error ? err.message : "Something went wrong.";
  }

  async function submitTyped() {
    const text = typedText.trim();
    if (!text || busy) return;
    setBusy(true);
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
      setNotice(handleVoiceError(err));
    } finally {
      setBusy(false);
    }
  }

  // Tappable answers for the agent's questions (also the only path for typed-only judges).
  async function answerIssue(issue: DraftIssue, answer: string) {
    if (!draft || busy) return;
    setBusy(true);
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
          setExpressions(await api<ExpressionRecord[]>(`/api/expressions?patient_id=${encodeURIComponent(draft.patient_id)}`));
        }
        setDraft(
          await api<DraftRecord>(`/api/drafts/${draft.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              expected_revision: draft.revision,
              reason: "clarification_answer",
              resolve_issue_ids: [issue.id],
            }),
          }),
        );
        return;
      }
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
      setDraft(
        await api<DraftRecord>(`/api/drafts/${draft.id}`, {
          method: "PATCH",
          body: JSON.stringify({ expected_revision: draft.revision, reason: "clarification_answer", ...patch }),
        }),
      );
    } catch (err) {
      setNotice(handleVoiceError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndSave(retry = false) {
    if (!draft || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const confirmed =
        retry && draft.status === "CONFIRMED"
          ? draft
          : await api<DraftRecord>(`/api/drafts/${draft.id}/confirm`, {
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
      // The note is saved: close the voice session so the mic is off and nothing bills.
      voice.stop();
      setNotice(saved.reused ? "That report was already saved — no duplicate was created." : "Saved. You'll find it under History.");
    } catch (err) {
      setNotice(handleVoiceError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetDemo() {
    if (busy) return;
    if (!window.confirm("Reset the demo? This starts a clean fictional workspace.")) return;
    setBusy(true);
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
      setTypedOpen(false);
      setSaveKey(null);
      saveKeyRevisionRef.current = null;
      setView("home");
      setNotice("Demo reset. A clean fictional workspace is ready.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The demo could not be reset.");
    } finally {
      setBusy(false);
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
    if (summaryFrom) params.set("from", new Date(summaryFrom).toISOString());
    if (summaryTo) params.set("to", new Date(summaryTo).toISOString());
    try {
      const payload = await api<{ reports: ReportRecord[] }>(`/api/reports/summary?${params.toString()}`);
      setSummary(payload.reports);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The summary could not be loaded.");
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
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center p-6 text-center">
        <h1 className="text-3xl font-bold">VoiceCare</h1>
        <p className="mt-4 text-zinc-600" role="status">Preparing your demo session…</p>
      </main>
    );
  }

  if (loadState === "failed") {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center p-6 text-center">
        <h1 className="text-3xl font-bold">VoiceCare</h1>
        <p className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4" role="alert">
          {loadError ?? "The demo could not start."}
        </p>
        <button
          type="button"
          onClick={() => void loadAll()}
          className="mt-4 rounded-full bg-zinc-900 px-8 py-3 font-semibold text-white"
        >
          Try again
        </button>
      </main>
    );
  }

  const voiceActive = voice.status !== "idle" && voice.status !== "error";
  const statusText =
    voice.status === "requesting-mic"
      ? "Starting the microphone…"
      : voice.status === "connecting"
        ? "Connecting…"
        : voice.done && voice.status === "processing"
          ? "VoiceCare is checking what you observed…"
          : voice.done
            ? "Answered? Tap below to speak again."
            : voice.status === "ready"
              ? "Ready — speak naturally."
              : voice.status === "listening"
                ? "Listening… take your time. Tap when finished."
                : voice.status === "processing"
                  ? "Thinking…"
                  : voice.status === "error"
                    ? "Voice unavailable — type instead."
                    : loadState === "ready"
                      ? "Ready."
                      : "Preparing…";

  const blocking = draft?.unresolved_issues.filter((issue) => issue.blocking) ?? [];
  const tappable = blocking.filter((issue) => issue.options.length > 0 || issue.code === "expression_permission");
  const nonBlockingPermission =
    draft?.unresolved_issues.filter((issue) => !issue.blocking && issue.code === "expression_permission") ?? [];
  const canConfirm =
    !!draft &&
    draft.status !== "CONFIRMED" &&
    draft.status !== "SAVED" &&
    blocking.length === 0 &&
    (draft.measurements.length > 0 || draft.observations.length > 0);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col p-4 sm:p-6">
      <header className="text-center">
        <h1 className="text-3xl font-bold">VoiceCare</h1>
        {view === "home" && (
          <p className="mt-1 text-sm text-zinc-500">
            Tap Speak, then describe what you observed{patient ? ` for ${patient.display_name}` : ""} in your own words.
          </p>
        )}
      </header>

      {view === "home" ? (
        <>
          <p className="mt-4 text-center text-sm font-medium text-zinc-600" role="status">
            {statusText}
          </p>

          <div className="mt-4 flex flex-col items-center">
            {!voiceActive ? (
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  void ensureDraft()
                    .then(() => voice.start())
                    .catch((err: unknown) => setNotice(err instanceof Error ? err.message : "Voice could not start."));
                }}
                disabled={busy}
                aria-label="Speak care note"
                className="h-36 w-36 rounded-full bg-zinc-900 text-xl font-bold text-white shadow-lg transition hover:bg-zinc-700 active:scale-95 disabled:opacity-50"
              >
                Speak Care Note
              </button>
            ) : !voice.done ? (
              <>
                <button
                  type="button"
                  onClick={voice.finishSpeaking}
                  aria-label="Done speaking"
                  className="h-36 w-36 animate-pulse rounded-full bg-amber-500 text-xl font-bold text-white shadow-lg transition hover:bg-amber-600 active:scale-95"
                >
                  Done Speaking
                </button>
                <button
                  type="button"
                  onClick={voice.cancelSpeaking}
                  className="mt-2 text-sm font-semibold text-zinc-400 underline underline-offset-4 hover:text-zinc-600"
                >
                  Cancel without processing
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={voice.resumeSpeaking}
                  aria-label="Tap to answer"
                  disabled={!voice.connected}
                  className="h-36 w-36 rounded-full bg-zinc-900 text-xl font-bold text-white shadow-lg transition hover:bg-zinc-700 active:scale-95 disabled:opacity-50"
                >
                  Tap to Answer
                </button>
                <button
                  type="button"
                  onClick={voice.cancelSpeaking}
                  className="mt-2 text-sm font-semibold text-zinc-400 underline underline-offset-4 hover:text-zinc-600"
                >
                  End session
                </button>
              </>
            )}
          </div>

          <div
            ref={conversationRef}
            aria-label="Conversation"
            aria-live="polite"
            className="mt-4 max-h-72 flex-1 overflow-auto rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-left"
          >
            {voice.lines.length === 0 && !voice.liveUser && !voice.liveAgent && !draft?.readback ? (
              <p className="text-sm text-zinc-400">
                What you say — and what VoiceCare hears — appears here.
              </p>
            ) : (
              <ul className="space-y-2 text-[15px] leading-relaxed">
                {voice.lines.map((line, index) => (
                  <li key={index} className={line.speaker === "you" ? "text-zinc-900" : "text-zinc-700"}>
                    <strong className="font-semibold">{line.speaker === "you" ? "You" : "VoiceCare"}: </strong>
                    {line.text}
                  </li>
                ))}
                {voice.liveUser && (
                  <li className="text-zinc-900 opacity-70">
                    <strong className="font-semibold">You: </strong>
                    {voice.liveUser}…
                  </li>
                )}
                {voice.liveAgent && (
                  <li className="text-zinc-700 opacity-70">
                    <strong className="font-semibold">VoiceCare: </strong>
                    {voice.liveAgent}…
                  </li>
                )}
                {draft && draft.readback && (draft.status === "REVIEWABLE" || draft.status === "CONFIRMED" || draft.status === "SAVED") && (
                  <li className="rounded-xl bg-white p-2 text-zinc-800 shadow-sm">
                    <strong className="font-semibold">To confirm: </strong>
                    {draft.readback}
                  </li>
                )}
              </ul>
            )}
          </div>

          {tappable.length > 0 && (
            <div className="mt-3 space-y-2">
              {tappable.map((issue) => (
                <div key={issue.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium">{issue.question}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {issue.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        disabled={busy}
                        onClick={() => void answerIssue(issue, option)}
                        className="rounded-full bg-white px-4 py-2 text-sm font-semibold shadow-sm transition hover:bg-amber-100 disabled:opacity-50"
                      >
                        {option}
                      </button>
                    ))}
                    {issue.code === "expression_permission" && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void answerIssue(issue, "__remember__")}
                          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          Remember
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void answerIssue(issue, "__forget__")}
                          className="rounded-full bg-white px-4 py-2 text-sm font-semibold shadow-sm disabled:opacity-50"
                        >
                          Just once
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(canConfirm || draft?.status === "CONFIRMED") && (
            <div className="mt-3 rounded-2xl border border-green-200 bg-green-50 p-4 text-center">
              <p className="font-semibold">Everything is checked. Save this report?</p>
              <div className="mt-2 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => void confirmAndSave()}
                  disabled={busy}
                  className="rounded-full bg-green-700 px-8 py-3 text-lg font-bold text-white transition hover:bg-green-800 disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Confirm and save"}
                </button>
                {draft?.status === "CONFIRMED" && (
                  <button
                    type="button"
                    onClick={() => void confirmAndSave(true)}
                    disabled={busy}
                    className="rounded-full border border-green-700 px-4 py-2 font-semibold text-green-800 disabled:opacity-50"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}

          {nonBlockingPermission.length > 0 && !canConfirm && (
            <div className="mt-3 space-y-2">
              {nonBlockingPermission.map((issue) => (
                <div key={issue.id} className="rounded-2xl border border-zinc-200 bg-white p-3">
                  <p className="text-sm">{issue.question}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void answerIssue(issue, "__remember__")}
                      className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Remember
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void answerIssue(issue, "__forget__")}
                      className="rounded-full border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                      Just once
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 text-center">
            {!typedOpen ? (
              <button
                type="button"
                onClick={() => setTypedOpen(true)}
                className="text-sm font-semibold text-zinc-600 underline underline-offset-4"
              >
                Type instead
              </button>
            ) : (
              <div className="rounded-2xl border border-zinc-200 p-3 text-left">
                <label htmlFor="typed-observation" className="text-sm font-semibold">
                  Type what you observed
                </label>
                <textarea
                  id="typed-observation"
                  value={typedText}
                  onChange={(event) => setTypedText(event.target.value)}
                  rows={3}
                  placeholder="Her pressure was 138 over 88…"
                  className="mt-1 w-full rounded-xl border border-zinc-300 p-2 text-[15px]"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void submitTyped()}
                    disabled={busy || typedText.trim().length === 0}
                    className="rounded-full bg-zinc-900 px-6 py-2.5 font-semibold text-white disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setTypedOpen(false)}
                    className="rounded-full border px-4 py-2 text-sm font-semibold"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>

          {notice && (
            <p role="status" className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-center text-sm">
              {notice}
            </p>
          )}
          {(voice.error || draft?.unresolved_statement) && (
            <p className="mt-2 text-center text-sm text-zinc-500">
              {voice.error ?? draft?.unresolved_statement}
            </p>
          )}

          <nav aria-label="Demo" className="mt-4 flex justify-center gap-3 pb-6">
            <button
              type="button"
              onClick={() => {
                setSelectedReport(null);
                setView("history");
              }}
              className="rounded-full border border-zinc-300 px-8 py-3 font-semibold transition hover:bg-zinc-100"
            >
              History{reports.length > 0 ? ` (${reports.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => void resetDemo()}
              disabled={busy}
              className="rounded-full border border-zinc-300 px-8 py-3 font-semibold transition hover:bg-zinc-100 disabled:opacity-50"
            >
              Reset
            </button>
          </nav>
        </>
      ) : (
        <>
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => setView("home")}
              className="rounded-full border border-zinc-300 px-8 py-3 font-semibold transition hover:bg-zinc-100"
            >
              ← Back
            </button>
          </div>

          <section aria-label="Saved reports" className="mt-4">
            <h2 className="text-center text-lg font-bold">History</h2>
            {reports.length === 0 ? (
              <p className="mt-2 text-center text-sm text-zinc-500">Saved reports appear here.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {reports.map((report) => (
                  <li key={report.id}>
                    <button
                      type="button"
                      onClick={() => void openReport(report.id)}
                      className="w-full rounded-2xl border border-zinc-200 bg-white p-3 text-left transition hover:bg-zinc-50"
                    >
                      <span className="font-semibold">
                        {new Date(report.observation_time ?? report.entry_time).toLocaleString([], {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                      <span className="block text-sm text-zinc-600">
                        {report.measurements
                          .map((m) => `${m.type.replace(/_/g, " ")} ${measurementText(m.type, m.systolic, m.diastolic, m.value)} ${m.unit ?? ""}`)
                          .join(" · ")}
                        {report.observations.length > 0 ? ` · ${report.observations.map((o) => o.text).join("; ")}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedReport && (
              <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4">
                <p className="text-sm text-zinc-500">In your words: “{selectedReport.original_transcript}”</p>
                <ul className="mt-2 space-y-1 text-[15px]">
                  {selectedReport.measurements.map((m) => (
                    <li key={m.id}>
                      <strong className="font-semibold">{m.type.replace(/_/g, " ")}:</strong>{" "}
                      {measurementText(m.type, m.systolic, m.diastolic, m.value)} {m.unit ?? "(unit unknown)"}
                    </li>
                  ))}
                  {selectedReport.observations.map((o) => (
                    <li key={o.id}>
                      {o.negated ? "No " : ""}
                      {o.text}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {selectedReport.supersedes_report_id && (
                    <button type="button" onClick={() => void openReport(selectedReport.supersedes_report_id!)} className="underline underline-offset-4">
                      Earlier version
                    </button>
                  )}
                  {selectedReport.superseded_by_report_id && (
                    <button type="button" onClick={() => void openReport(selectedReport.superseded_by_report_id!)} className="underline underline-offset-4">
                      Newer version
                    </button>
                  )}
                  <button type="button" onClick={() => setSelectedReport(null)} className="underline underline-offset-4">
                    Close
                  </button>
                </div>
              </div>
            )}
          </section>

          <section aria-label="Appointment summary" className="mt-6 text-center">
            <h2 className="text-lg font-bold">Appointment summary</h2>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-sm">
              <label>
                From <input type="date" value={summaryFrom} onChange={(e) => setSummaryFrom(e.target.value)} className="rounded-lg border p-1.5" />
              </label>
              <label>
                To <input type="date" value={summaryTo} onChange={(e) => setSummaryTo(e.target.value)} className="rounded-lg border p-1.5" />
              </label>
              <button type="button" onClick={() => void loadSummary()} className="rounded-full border px-4 py-1.5 font-semibold">
                Load
              </button>
              {summary && summary.length > 0 && (
                <button type="button" onClick={() => window.print()} className="rounded-full bg-zinc-900 px-4 py-1.5 font-semibold text-white">
                  Print
                </button>
              )}
            </div>
            {summary && (
              <div className="mt-2 rounded-2xl border border-zinc-200 bg-white p-3 text-left text-sm" id="print-summary">
                <p className="font-semibold">Caregiver-reported observations. Review before making medical decisions.</p>
                {summary.length === 0 ? (
                  <p className="mt-1">No reports in this range.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {summary.map((report) => (
                      <li key={report.id}>
                        <strong>
                          {new Date(report.observation_time ?? report.entry_time).toLocaleString([], {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                          :
                        </strong>{" "}
                        {report.measurements
                          .map((m) => `${m.type.replace(/_/g, " ")} ${measurementText(m.type, m.systolic, m.diastolic, m.value)} ${m.unit ?? ""}`)
                          .join("; ")}
                        {report.observations.length > 0 && `; ${report.observations.map((o) => `${o.negated ? "no " : ""}${o.text}`).join("; ")}`}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {expressions.length > 0 && (
            <section aria-label="Remembered phrases" className="mt-6 pb-6">
              <h2 className="text-center text-lg font-bold">Remembered phrases</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {expressions.map((expression) => (
                  <li key={expression.id} className="flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white p-2.5">
                    <span>
                      “{expression.phrase}” → {expression.measurement_type.replace(/_/g, " ")}
                      {expression.unit ? ` (${expression.unit})` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteExpression(expression.id)}
                      aria-label={`Forget ${expression.phrase}`}
                      className="rounded-full border px-3 py-1"
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <footer className="pb-4 text-center text-xs text-zinc-400">
        <p>Experimental prototype with fictional information only — not for real patient care.</p>
      </footer>
    </main>
  );
}
