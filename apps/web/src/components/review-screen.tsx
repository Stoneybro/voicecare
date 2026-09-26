"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CalendarClock, CircleAlert, ClipboardCheck, HeartPulse, LoaderCircle, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClarificationScreen } from "@/components/clarification-screen";

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
  status: "NEEDS_CLARIFICATION" | "REVIEWABLE";
  original_transcript: string;
  measurements: Measurement[];
  observations: Observation[];
  observation_time: string | null;
  observation_time_precision: string;
  observation_time_source: string | null;
  unresolved_issues: Issue[];
};

type ReviewScreenProps = { draftId: string; onBack: () => void };

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

function measurementValue(measurement: Measurement): string {
  if (typeof measurement.value === "object" && measurement.value !== null) {
    return `${measurement.value.systolic} / ${measurement.value.diastolic}`;
  }
  return String(measurement.value);
}

export function ReviewScreen({ draftId, onBack }: ReviewScreenProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clarifying, setClarifying] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadDraft() {
      try {
        const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(payload));
        if (active) setDraft(payload.draft as Draft);
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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-10 pt-5 sm:px-6">
      <header className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          Workspace
        </Button>
        <Badge variant={needsClarification ? "outline" : "secondary"}>
          {needsClarification ? "Needs clarification" : "Ready to review"}
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
            <Button onClick={() => setClarifying(true)}>
              <Mic data-icon="inline-start" aria-hidden />Clarify with voice
            </Button>
            <p className="self-center text-xs text-muted-foreground">You can also leave these details flagged and review later.</p>
          </div>
        </section>
      )}

      <section className="mt-5" aria-labelledby="measurements-heading">
        <h2 id="measurements-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Measurements
        </h2>
        {draft.measurements.length ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {draft.measurements.map((measurement, index) => (
              <Card key={`${measurement.type}-${index}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{measurementLabels[measurement.type] ?? measurement.type}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">
                    {measurementValue(measurement)}
                    {measurement.unit && <span className="ml-2 text-sm font-normal text-muted-foreground">{measurement.unit}</span>}
                  </p>
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
        {draft.observations.length ? (
          <div className="mt-3 space-y-3">
            {draft.observations.map((observation, index) => (
              <Card key={`${observation.type}-${index}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{observationLabels[observation.type] ?? observation.type}</CardTitle>
                  <CardDescription>{observation.description}</CardDescription>
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
        {draft.observation_time && (
          <CardContent className="text-xs text-muted-foreground">
            Interpreted as {new Date(draft.observation_time).toLocaleString()}
          </CardContent>
        )}
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

      <p className="mt-5 text-center text-xs text-muted-foreground">
        This is an automatically organized draft, not a diagnosis or medical advice.
      </p>
    </main>
  );
}
