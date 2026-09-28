"use client";

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Brain, CircleAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Expression = {
  id: string;
  phrase: string;
  patient_id: string | null;
  patient_name: string | null;
  normalized_meaning: { measurement_type?: string; unit?: string | null };
};

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object" &&
    "message" in payload.error && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

export function PersonalExpressionsScreen({ onBack }: { onBack: () => void }) {
  const [expressions, setExpressions] = useState<Expression[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/expressions", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "Remembered phrases could not be loaded."));
      setExpressions(Array.isArray(payload?.expressions) ? payload.expressions as Expression[] : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remembered phrases could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetching is the screen's initial synchronization with the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function remove(expression: Expression): Promise<void> {
    setDeleting(expression.id);
    setError(null);
    try {
      const response = await fetch(`/api/expressions/${encodeURIComponent(expression.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "That phrase could not be deleted."));
      setExpressions((current) => current.filter((entry) => entry.id !== expression.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That phrase could not be deleted.");
    } finally {
      setDeleting(null);
    }
  }

  return <main className="care-screen mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-8 pt-5 sm:px-6">
    <header><Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden />Back</Button></header>
    <section className="mt-6"><p className="eyebrow mb-3">IN YOUR OWN WORDS</p><h1 className="text-2xl font-semibold">Remembered phrases</h1><p className="mt-2 text-sm text-muted-foreground">VoiceCare only saves a phrase after you choose “Yes, remember.” You can remove one at any time.</p></section>
    {error && <Card className="mt-5 border-destructive/40"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><CircleAlert className="size-4" aria-hidden />Could not update phrases</CardTitle><CardDescription>{error}</CardDescription></CardHeader><CardContent><Button variant="outline" onClick={() => void load()}>Try again</Button></CardContent></Card>}
    <section className="mt-5 flex flex-col gap-3" aria-live="polite">
      {loading ? <p className="text-sm text-muted-foreground">Loading remembered phrases…</p> : expressions.length === 0 ? <Empty className="min-h-64 border"><EmptyHeader><EmptyMedia variant="icon"><Brain aria-hidden /></EmptyMedia><EmptyTitle>A little understanding goes a long way.</EmptyTitle><EmptyDescription>When you explain a phrase during review, you can choose to remember it for next time. The phrases you save will live here.</EmptyDescription></EmptyHeader></Empty> : expressions.map((expression) => <Card key={expression.id}><CardContent className="flex items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="font-medium">“{expression.phrase}” <span className="text-muted-foreground">means</span> {expression.normalized_meaning.measurement_type?.replaceAll("_", " ")}</p><p className="mt-1 text-xs text-muted-foreground">{expression.patient_name ?? "All patients"}{expression.normalized_meaning.unit ? ` · ${expression.normalized_meaning.unit}` : ""}</p></div><Button aria-label={`Delete ${expression.phrase}`} title="Delete phrase" variant="ghost" size="icon" disabled={deleting === expression.id} onClick={() => void remove(expression)}><Trash2 className="size-4" aria-hidden /></Button></CardContent></Card>)}
    </section>
  </main>;
}
