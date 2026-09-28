"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, CircleAlert, Check, ClipboardCheck, LoaderCircle, Mic, Save, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VoiceAssistantPanel } from "@/components/clarification-screen";
import { Input } from "@/components/ui/input";

type Measurement = {
  type: string;
  value: number | string | { systolic: number; diastolic: number };
  unit: string | null;
  confidence: number;
  source_text: string;
};

type Observation = {
  type: string;
  description: string;
  confidence: number;
  source_text: string;
};

type Issue = {
  id: string;
  type: string;
  message: string;
  question: string;
  source_text: string;
  blocking: boolean;
};

type ExpressionSuggestion = {
  suggestion_id: string;
  phrase: string;
  measurement_type: string;
  unit: string | null;
  patient_id: string;
  patient_name: string;
};

type ExpressionCandidate = {
  candidate_id: string;
  phrase: string;
  source_text: string;
  patient_id: string;
  patient_name: string;
};

type Draft = {
  id: string;
  patient_name: string;
  revision: number;
  status: "NEEDS_CLARIFICATION" | "REVIEWABLE" | "CONFIRMED" | "SAVED";
  original_transcript: string;
  measurements: Measurement[];
  observations: Observation[];
  observation_time: string | null;
  observation_time_precision: string;
  observation_time_source: string | null;
  unresolved_issues: Issue[];
  confirmation_method: "button" | "voice" | null;
  confirmed_at: string | null;
  confirmed_revision: number | null;
};

type NoteReviewProps = { draftId: string; onSaved: (reportId: string) => void; onBusyChange: (busy: boolean) => void };

const measurementLabels: Record<string, string> = {
  blood_pressure: "Blood pressure",
  blood_glucose: "Blood glucose",
  temperature: "Temperature",
  heart_rate: "Heart rate",
  spo2: "Oxygen saturation",
};

const observationLabels: Record<string, string> = {
  symptom: "Symptom",
  pain: "Pain",
  food: "Food and drink",
  mood: "Mood",
  sleep: "Sleep",
  free_text: "Observation",
};

function responseError(payload: unknown): string {
  if (
    payload && typeof payload === "object" && "error" in payload && payload.error &&
    typeof payload.error === "object" && "message" in payload.error && typeof payload.error.message === "string"
  ) return payload.error.message;
  return "Could not load this draft. Please try again.";
}

function localDateTimeInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function NoteReview({ draftId, onSaved, onBusyChange }: NoteReviewProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [aiExtractionAvailable, setAiExtractionAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clarifying, setClarifying] = useState(false);
  const [reload, setReload] = useState(0);
  const [agentMode, setAgentMode] = useState<"clarification" | "confirmation" | "expression">("clarification");
  const [activeCandidateId, setActiveCandidateId] = useState<string | undefined>();
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [expressionSuggestions, setExpressionSuggestions] = useState<ExpressionSuggestion[]>([]);
  const [expressionCandidates, setExpressionCandidates] = useState<ExpressionCandidate[]>([]);
  const [candidateChoices, setCandidateChoices] = useState<Record<string, string>>({});
  const [savingSuggestion, setSavingSuggestion] = useState<string | null>(null);
  const [observationTime, setObservationTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => { onBusyChange(saving || clarifying); return () => onBusyChange(false); }, [saving, clarifying, onBusyChange]);

  useEffect(() => {
    let active = true;
    async function loadDraft() {
      try {
        setError(null);
        const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(payload));
        if (active) {
          const loaded = payload.draft as Draft;
          setDraft(loaded);
          setAiExtractionAvailable(payload.ai_extraction_available !== false);
          setMeasurements(loaded.measurements);
          setObservations(loaded.observations);
          setObservationTime(localDateTimeInput(loaded.observation_time));
          let dismissedSuggestionIds: string[] = [];
          try {
            const dismissed = JSON.parse(sessionStorage.getItem(`voicecare-dismissed-expressions:${draftId}`) ?? "[]");
            if (Array.isArray(dismissed)) dismissedSuggestionIds = dismissed.filter((id): id is string => typeof id === "string");
          } catch { /* Dismissals are a convenience; storage may be unavailable. */ }
          const dismissed = new Set(dismissedSuggestionIds);
          setExpressionSuggestions(Array.isArray(payload.expression_suggestions)
            ? (payload.expression_suggestions as ExpressionSuggestion[]).filter((suggestion) => !dismissed.has(suggestion.suggestion_id))
            : []);
          setExpressionCandidates(Array.isArray(payload.expression_candidates)
            ? (payload.expression_candidates as ExpressionCandidate[]).filter((candidate) => !dismissed.has(candidate.candidate_id))
            : []);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load this draft.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadDraft();
    return () => { active = false; };
  }, [draftId, reload]);

  if (loading) {
    return (
      <section className="mx-auto flex min-h-48 w-full max-w-2xl flex-col items-center justify-center gap-3 p-6 text-center">
        <LoaderCircle className="size-6 animate-spin text-primary" aria-hidden />
        <p className="text-sm text-muted-foreground">Preparing your draft review...</p>
      </section>
    );
  }

  if (error || !draft) {
    return (
      <section className="mx-auto flex min-h-48 w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <CircleAlert className="size-8 text-destructive" aria-hidden />
        <h1 className="text-lg font-semibold">Draft unavailable</h1>
        <p className="text-sm text-muted-foreground">{error ?? "Could not load this draft."}</p>
        <Button variant="outline" onClick={() => setReload((value) => value + 1)}>Try again</Button>
      </section>
    );
  }

  const needsClarification = draft.status === "NEEDS_CLARIFICATION";
  const confirmed = draft.status === "CONFIRMED" || draft.status === "SAVED";
  const editable = !confirmed && !saving && !clarifying;
  const loadedTime = localDateTimeInput(draft.observation_time);
  const hasUnsavedChanges = JSON.stringify(measurements) !== JSON.stringify(draft.measurements) ||
    JSON.stringify(observations) !== JSON.stringify(draft.observations) || observationTime !== loadedTime;

  function updateMeasurement(index: number, patch: Partial<Measurement>): void {
    setMeasurements((current) => current.map((measurement, currentIndex) => currentIndex === index ? { ...measurement, ...patch } : measurement));
  }

  async function persistCorrections(): Promise<string> {
    const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        measurements,
        observations,
        observation_time: observationTime ? new Date(observationTime).toISOString() : null,
        observation_time_precision: observationTime ? "exact" : draft?.observation_time_precision ?? "unknown",
        observation_time_source: observationTime ? "caregiver correction" : draft?.observation_time_source ?? null,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(payload));
    return typeof payload.status === "string" ? payload.status : "NEEDS_CLARIFICATION";
  }

  async function saveCorrections(): Promise<void> {
    setSaving(true);
    setNotice(null);
    try {
      await persistCorrections();
      setNotice("Corrections saved as a new draft revision.");
      setReload((value) => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not save these corrections.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmWithButton(): Promise<void> {
    if (mutationRef.current) return;
    mutationRef.current = true;
    let confirmationRequested = false;
    setSaving(true);
    setNotice(null);
    try {
      if (hasUnsavedChanges) {
        const updatedStatus = await persistCorrections();
        if (updatedStatus !== "REVIEWABLE") {
          setReload((value) => value + 1);
          throw new Error("Corrections saved, but unresolved details still need clarification before confirmation.");
        }
      }
      confirmationRequested = true;
      const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "button" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload));
      setDraft((current) => current ? { ...current, status: "CONFIRMED", confirmation_method: "button", confirmed_at: payload.confirmed_at, confirmed_revision: payload.confirmed_revision } : current);
      await saveReport();
    } catch (cause) {
      if (confirmationRequested) setReload((value) => value + 1);
      setNotice(cause instanceof Error ? cause.message : "Could not confirm this draft.");
    } finally {
      mutationRef.current = false;
      setSaving(false);
    }
  }

  async function startVoiceConfirmation(): Promise<void> {
    setSaving(true);
    setNotice(null);
    try {
      if (hasUnsavedChanges) {
        const updatedStatus = await persistCorrections();
        if (updatedStatus !== "REVIEWABLE") {
          setReload((value) => value + 1);
          throw new Error("Corrections saved, but unresolved details still need clarification before confirmation.");
        }
      }
      setAgentMode("confirmation");
      setClarifying(true);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not prepare this draft for confirmation.");
    } finally {
      setSaving(false);
    }
  }

  async function saveReport(): Promise<void> {
    setSaving(true);
    setNotice(null);
    try {
      idempotencyKeyRef.current ??= typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${draftId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKeyRef.current },
        body: JSON.stringify({ draft_id: draftId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || typeof payload?.report_id !== "string") throw new Error(responseError(payload));
      onSaved(payload.report_id);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not save this report.");
    } finally {
      setSaving(false);
    }
  }

  async function rememberExpression(suggestion: ExpressionSuggestion): Promise<void> {
    setSavingSuggestion(suggestion.suggestion_id);
    setNotice(null);
    try {
      const response = await fetch("/api/expressions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft_id: draftId, suggestion_id: suggestion.suggestion_id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload));
      setExpressionSuggestions((current) => current.filter((entry) => entry.suggestion_id !== suggestion.suggestion_id));
      setNotice(`I'll remember “${suggestion.phrase}” for ${suggestion.patient_name}.`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "That phrase could not be remembered.");
    } finally {
      setSavingSuggestion(null);
    }
  }

  async function openVoice(mode: "clarification" | "expression", candidateId?: string): Promise<void> {
    setSaving(true);
    setNotice(null);
    try {
      if (hasUnsavedChanges) await persistCorrections();
      setActiveCandidateId(candidateId);
      setAgentMode(mode);
      setClarifying(true);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not prepare voice assistance.");
    } finally { setSaving(false); }
  }

  async function finishVoice(): Promise<void> {
    setClarifying(false);
    setSaving(true);
    try {
      const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.draft) throw new Error(responseError(payload));
      if (agentMode === "confirmation" && ["CONFIRMED", "SAVED"].includes(payload.draft.status)) {
        setDraft(payload.draft as Draft);
        await saveReport();
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not refresh the update. Please try again.");
    } finally {
      setReload((value) => value + 1);
      setSaving(false);
    }
  }

  async function resolveExpression(candidate: ExpressionCandidate, answer: string): Promise<void> {
    setSavingSuggestion(candidate.candidate_id);
    setNotice(null);
    try {
      const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/expressions/clarify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidate_id: candidate.candidate_id, answer }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload));
      if (!payload?.resolved) {
        setNotice(typeof payload?.message === "string" ? payload.message : "Choose a measurement type from the list.");
        return;
      }
      setCandidateChoices((current) => { const next = { ...current }; delete next[candidate.candidate_id]; return next; });
      setReload((value) => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "That phrase could not be clarified.");
    } finally {
      setSavingSuggestion(null);
    }
  }

  function dismissExpression(suggestionId: string): void {
    setExpressionSuggestions((current) => current.filter((entry) => entry.suggestion_id !== suggestionId));
    setExpressionCandidates((current) => current.filter((entry) => entry.candidate_id !== suggestionId));
    try {
      const key = `voicecare-dismissed-expressions:${draftId}`;
      const existing = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      const dismissed = Array.isArray(existing) ? existing.filter((id): id is string => typeof id === "string") : [];
      sessionStorage.setItem(key, JSON.stringify([...new Set([...dismissed, suggestionId])]));
    } catch { /* Dismissals are a convenience; storage may be unavailable. */ }
  }

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-10 sm:px-6 lg:px-8" aria-label="Review care update">
      <div className="my-6 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-semibold">Review your update</h2><p className="mt-1 text-sm text-muted-foreground">Check what was captured, then confirm and save.</p></div>
        <Badge variant={needsClarification ? "outline" : confirmed ? "default" : "secondary"}>
          {needsClarification ? "Details to clarify" : confirmed ? "Confirmed" : "Ready to review"}
        </Badge>
      </div>
      {clarifying && <VoiceAssistantPanel key={`${agentMode}-${activeCandidateId ?? "note"}`} draftId={draftId} mode={agentMode} candidateId={activeCandidateId} onBack={() => void finishVoice()} onReview={() => void finishVoice()} />}
      <fieldset disabled={saving || clarifying} className="min-w-0 border-0 p-0" aria-label="Care update details">
      {!aiExtractionAvailable && (
        <Alert className="mt-4"><CircleAlert aria-hidden /><AlertTitle>Give this update an extra check</AlertTitle><AlertDescription>Some details may need correcting. Compare the summary with your original words below.</AlertDescription></Alert>
      )}

      {needsClarification && (
        <section className="mt-5" aria-labelledby="issues-heading">
          <div className="rounded-xl border border-warning/30 bg-warning-surface p-4">
            <h2 id="issues-heading" className="flex items-center gap-2 font-medium">
              <CircleAlert className="size-4 text-warning" aria-hidden />
              Details to clarify
            </h2>
            <ul className="mt-3 flex flex-col gap-3">
              {draft.unresolved_issues.map((issue) => (
                <li key={issue.id} className="rounded-lg bg-background/80 p-3">
                  <p className="text-sm">{issue.message}</p>
                  <p className="mt-1 text-sm font-medium">{issue.question}</p>
                  {issue.source_text && <p className="mt-1 text-xs text-muted-foreground">From: “{issue.source_text}”</p>}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {!confirmed && <Button onClick={() => void openVoice("clarification")}>
              <Mic data-icon="inline-start" aria-hidden />Clarify with voice
            </Button>}
            <p className="self-center text-xs text-muted-foreground">You can also leave these details flagged and review later.</p>
          </div>
        </section>
      )}

      {expressionCandidates.length > 0 && (
        <section className="mt-4 flex flex-col gap-3" aria-label="Unusual phrase clarification">
          {expressionCandidates.map((candidate) => (
            <Card key={candidate.candidate_id} className="border-primary/30">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="size-4" aria-hidden />What does “{candidate.phrase}” mean?</CardTitle>
                <CardDescription>From this update: “{candidate.source_text}”. VoiceCare has not guessed what “{candidate.phrase}” means. You can explain it or choose a meaning below.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Button variant="outline" onClick={() => void openVoice("expression", candidate.candidate_id)} disabled={savingSuggestion !== null}>
                  <Mic data-icon="inline-start" aria-hidden />Explain by voice
                </Button>
                <label className="flex-1 text-xs text-muted-foreground">Or choose what it means
                  <select
                    aria-label={`Meaning of ${candidate.phrase}`}
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={candidateChoices[candidate.candidate_id] ?? ""}
                    onChange={(event) => setCandidateChoices((current) => ({ ...current, [candidate.candidate_id]: event.target.value }))}
                    disabled={savingSuggestion !== null}
                  >
                    <option value="">Choose a measurement</option>
                    {Object.entries(measurementLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <Button onClick={() => void resolveExpression(candidate, candidateChoices[candidate.candidate_id] ?? "")} disabled={!candidateChoices[candidate.candidate_id] || savingSuggestion !== null}>
                  {savingSuggestion === candidate.candidate_id ? "Saving…" : "Use this meaning"}
                </Button>
                <Button variant="ghost" onClick={() => dismissExpression(candidate.candidate_id)} disabled={savingSuggestion !== null}>Not now</Button>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {expressionSuggestions.length > 0 && (
        <section className="mt-4 flex flex-col gap-3" aria-label="Unusual phrase suggestions">
          {expressionSuggestions.map((suggestion) => (
            <Card key={suggestion.suggestion_id} className="border-primary/30">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="size-4" aria-hidden />Remember this meaning?</CardTitle>
                <CardDescription>You said “{suggestion.phrase}” means {measurementLabels[suggestion.measurement_type] ?? suggestion.measurement_type} for {suggestion.patient_name}. Should VoiceCare remember that? This won't change the current draft.</CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Button onClick={() => void rememberExpression(suggestion)} disabled={savingSuggestion !== null}>
                  {savingSuggestion === suggestion.suggestion_id ? "Saving…" : "Yes, remember"}
                </Button>
                <Button variant="outline" onClick={() => dismissExpression(suggestion.suggestion_id)} disabled={savingSuggestion !== null}>Not now</Button>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
      <section aria-labelledby="measurements-heading">
        <h2 id="measurements-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Measurements
        </h2>
        {measurements.length ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {measurements.map((measurement, index) => (
              <Card key={`${measurement.type}-${index}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{measurementLabels[measurement.type] ?? measurement.type}</CardTitle>
                </CardHeader>
                <CardContent>
                  {measurement.type === "blood_pressure" && typeof measurement.value === "object" ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                      <label className="text-xs text-muted-foreground">Systolic<Input aria-label="Systolic blood pressure" type="number" min="1" value={measurement.value.systolic} disabled={!editable} onChange={(event) => updateMeasurement(index, { value: { systolic: Number(event.target.value), diastolic: measurement.value && typeof measurement.value === "object" ? measurement.value.diastolic : 1 } })} /></label>
                      <span className="pb-2 text-muted-foreground">/</span>
                      <label className="text-xs text-muted-foreground">Diastolic<Input aria-label="Diastolic blood pressure" type="number" min="1" value={measurement.value.diastolic} disabled={!editable} onChange={(event) => updateMeasurement(index, { value: { systolic: measurement.value && typeof measurement.value === "object" ? measurement.value.systolic : 1, diastolic: Number(event.target.value) } })} /></label>
                    </div>
                  ) : (
                    <label className="text-xs text-muted-foreground">Value<Input aria-label={`${measurementLabels[measurement.type] ?? measurement.type} value`} type="number" step="any" min="0.01" value={typeof measurement.value === "object" ? "" : measurement.value} disabled={!editable} onChange={(event) => updateMeasurement(index, { value: Number(event.target.value) })} /></label>
                  )}
                  <label className="mt-2 block text-xs text-muted-foreground">Unit
                    <Input aria-label={`${measurementLabels[measurement.type] ?? measurement.type} unit`} value={measurement.unit ?? ""} placeholder="Enter unit" disabled={!editable} onChange={(event) => updateMeasurement(index, { unit: event.target.value.trim() || null })} />
                  </label>
                  <p className="mt-2 text-xs text-muted-foreground">Extracted from: “{measurement.source_text}”</p>
                  <p className="mt-1 text-xs text-muted-foreground">Extraction confidence: {Math.round(measurement.confidence * 100)}%</p>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="mt-3"><CardContent className="py-5 text-sm text-muted-foreground">No measurements were identified in this transcript.</CardContent></Card>
        )}
      </section>

      <section aria-labelledby="observations-heading">
        <h2 id="observations-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Observations
        </h2>
        {observations.length ? (
          <div className="mt-3 flex flex-col gap-3">
            {observations.map((observation, index) => (
              <Card key={`${observation.type}-${index}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{observationLabels[observation.type] ?? observation.type}</CardTitle>
                  <CardDescription>
                    <Input aria-label={`${observationLabels[observation.type] ?? observation.type} description`} value={observation.description} disabled={!editable} onChange={(event) => setObservations((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, description: event.target.value, source_text: event.target.value } : item))} />
                    <span className="mt-1 block text-xs text-muted-foreground">From this update: “{observation.source_text}”</span>
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="mt-3"><CardContent className="py-5 text-sm text-muted-foreground">No separate observations were identified.</CardContent></Card>
        )}
      </section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
            When it happened
          </CardTitle>
          <CardDescription>
            {draft.observation_time_source
              ? `${draft.observation_time_source} (${draft.observation_time_precision})`
              : "No time was stated."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="text-xs text-muted-foreground">Observation date and time
            <Input aria-label="Observation date and time" type="datetime-local" value={observationTime} disabled={!editable} onChange={(event) => setObservationTime(event.target.value)} />
          </label>
          {draft.observation_time && <p className="mt-2 text-xs text-muted-foreground">Currently interpreted as {new Date(draft.observation_time).toLocaleString()}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClipboardCheck className="size-4 text-muted-foreground" aria-hidden />
            Original transcript
          </CardTitle>
        </CardHeader>
        <CardContent className="whitespace-pre-wrap text-sm leading-relaxed">{draft.original_transcript}</CardContent>
      </Card>
      </div>
      </div>


      {!confirmed ? (
        <div className="care-action-bar mt-5 flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => void saveCorrections()} disabled={saving || !hasUnsavedChanges}>
            {saving ? <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden /> : <Save data-icon="inline-start" aria-hidden />}
            Save corrections
          </Button>
          <Button onClick={() => void confirmWithButton()} disabled={saving || needsClarification || draft.unresolved_issues.length > 0}>
            <Check data-icon="inline-start" aria-hidden />Confirm &amp; save
          </Button>
          <Button variant="outline" onClick={() => void startVoiceConfirmation()} disabled={saving || needsClarification || draft.unresolved_issues.length > 0}>
            <Mic data-icon="inline-start" aria-hidden />Confirm &amp; save by voice
          </Button>
        </div>
      ) : (
        <Card className="mt-5"><CardContent className="py-4 text-sm">
        Confirmed by {draft.confirmation_method === "voice" ? "voice" : "button"}
          {draft.confirmed_at ? ` on ${new Date(draft.confirmed_at).toLocaleString()}` : ""}
          {draft.confirmed_revision ? ` (revision ${draft.confirmed_revision})` : ""}.
        </CardContent></Card>
      )}

      {confirmed && <Button className="mt-3" onClick={() => void saveReport()} disabled={saving}>
        {saving ? <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden /> : <Save data-icon="inline-start" aria-hidden />}
        Retry saving report
      </Button>}

      <p className="mt-5 text-center text-xs text-muted-foreground">
        This is an automatically organized draft, not a diagnosis or medical advice.
      </p>
      </fieldset>
      {notice && <p role="status" className="mt-4 text-center text-sm text-muted-foreground">{notice}</p>}
    </section>
  );
}
