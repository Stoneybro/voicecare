"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarClock, CircleAlert, Check, ClipboardCheck, HeartPulse, LoaderCircle, Mic, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClarificationScreen } from "@/components/clarification-screen";
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

type Draft = {
  id: string;
  patient_name: string;
  revision: number;
  status: "NEEDS_CLARIFICATION" | "REVIEWABLE" | "CONFIRMED";
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

type ReviewScreenProps = { draftId: string; onBack: () => void; onSaved: (reportId: string) => void };

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
  free_text: "Note",
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

export function ReviewScreen({ draftId, onBack, onSaved }: ReviewScreenProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clarifying, setClarifying] = useState(false);
  const [reload, setReload] = useState(0);
  const [agentMode, setAgentMode] = useState<"clarification" | "confirmation">("clarification");
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [observationTime, setObservationTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadDraft() {
      try {
        const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(payload));
        if (active) {
          const loaded = payload.draft as Draft;
          setDraft(loaded);
          setMeasurements(loaded.measurements);
          setObservations(loaded.observations);
          setObservationTime(localDateTimeInput(loaded.observation_time));
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

  if (clarifying) {
    return (
      <ClarificationScreen
        draftId={draftId}
        mode={agentMode}
        onBack={() => { setClarifying(false); setReload((value) => value + 1); }}
        onReview={() => { setClarifying(false); setReload((value) => value + 1); }}
      />
    );
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center gap-3 p-6 text-center">
        <LoaderCircle className="size-6 animate-spin text-primary" aria-hidden />
        <p className="text-sm text-muted-foreground">Preparing your draft review...</p>
      </main>
    );
  }

  if (error || !draft) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <CircleAlert className="size-8 text-destructive" aria-hidden />
        <h1 className="text-lg font-semibold">Draft unavailable</h1>
        <p className="text-sm text-muted-foreground">{error ?? "Could not load this draft."}</p>
        <Button variant="outline" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden />Back to workspace</Button>
      </main>
    );
  }

  const needsClarification = draft.status === "NEEDS_CLARIFICATION";
  const confirmed = draft.status === "CONFIRMED";
  const editable = !confirmed;
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
      const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "button" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload));
      setNotice("Draft confirmed.");
      setReload((value) => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not confirm this draft.");
    } finally {
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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-10 pt-5 sm:px-6">
      <header className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          Workspace
        </Button>
        <Badge variant={needsClarification ? "outline" : confirmed ? "default" : "secondary"}>
          {needsClarification ? "Needs clarification" : confirmed ? "Confirmed" : "Ready to review"}
        </Badge>
      </header>

      <section className="mt-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <HeartPulse className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-xs text-muted-foreground">Draft for {draft.patient_name}</p>
            <h1 className="text-2xl font-semibold tracking-tight">Transcript review</h1>
          </div>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          VoiceCare organized the update below. Check the extracted details before continuing.
        </p>
      </section>

      {needsClarification && (
        <section className="mt-5" aria-labelledby="issues-heading">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h2 id="issues-heading" className="flex items-center gap-2 font-medium">
              <CircleAlert className="size-4 text-amber-700" aria-hidden />
              Details to clarify
            </h2>
            <ul className="mt-3 space-y-3">
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
            {!confirmed && <Button onClick={() => { setAgentMode("clarification"); setClarifying(true); }}>
              <Mic data-icon="inline-start" aria-hidden />Clarify with voice
            </Button>}
            <p className="self-center text-xs text-muted-foreground">You can also leave these details flagged and review later.</p>
          </div>
        </section>
      )}

      <section className="mt-5" aria-labelledby="measurements-heading">
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

      <section className="mt-6" aria-labelledby="observations-heading">
        <h2 id="observations-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Observations
        </h2>
        {observations.length ? (
          <div className="mt-3 space-y-3">
            {observations.map((observation, index) => (
              <Card key={`${observation.type}-${index}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{observationLabels[observation.type] ?? observation.type}</CardTitle>
                  <CardDescription>
                    <Input aria-label={`${observationLabels[observation.type] ?? observation.type} description`} value={observation.description} disabled={!editable} onChange={(event) => setObservations((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, description: event.target.value, source_text: event.target.value } : item))} />
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="mt-3"><CardContent className="py-5 text-sm text-muted-foreground">No separate observations were identified.</CardContent></Card>
        )}
      </section>

      <Card className="mt-6">
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

      <Card className="mt-6">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClipboardCheck className="size-4 text-muted-foreground" aria-hidden />
            Original transcript
          </CardTitle>
        </CardHeader>
        <CardContent className="whitespace-pre-wrap text-sm leading-relaxed">{draft.original_transcript}</CardContent>
      </Card>

      {notice && <p role="status" className="mt-4 text-center text-sm text-muted-foreground">{notice}</p>}
      {!confirmed ? (
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => void saveCorrections()} disabled={saving || !hasUnsavedChanges}>
            {saving ? <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden /> : <Save data-icon="inline-start" aria-hidden />}
            Save corrections
          </Button>
          <Button onClick={() => void confirmWithButton()} disabled={saving || needsClarification || draft.unresolved_issues.length > 0}>
            <Check data-icon="inline-start" aria-hidden />Confirm draft
          </Button>
          <Button variant="outline" onClick={() => void startVoiceConfirmation()} disabled={saving || needsClarification || draft.unresolved_issues.length > 0}>
            <Mic data-icon="inline-start" aria-hidden />Confirm by voice
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
        Save report
      </Button>}

      <p className="mt-5 text-center text-xs text-muted-foreground">
        This is an automatically organized draft, not a diagnosis or medical advice.
      </p>
    </main>
  );
}
