"use client";

// Stage 1 home screen (spec/02 stages 1.1, 1.2, 1.5, 1.7): cold-start workspace with no login,
// a one-tap speak CTA around the voice orb, the patient switcher, report history, and a
// demo reset. All data comes from GET /api/bootstrap; the browser never touches the database.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Mic,
  Plus,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import type { BootstrapPayload } from "@/lib/bootstrap";
import { CareBrand } from "@/components/care-identity";
import { Orb } from "@/components/ui/orb";
import { Field, FieldLabel } from "@/components/ui/field";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CareNoteWorkspace } from "@/components/recording-screen";
import { ReportDetailPanel, ReportHistory } from "@/components/report-screens";
import { RememberedPhrasesPanel } from "@/components/personal-expressions-screen";

// The selected patient is remembered per browser so the judge lands on the same person (1.5).
const LAST_PATIENT_KEY = "voicecare:last-patient-id";

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = parts.map((part) => part.charAt(0).toUpperCase()).join("");
  return initials || "?";
}

function friendlyError(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

// __SPLIT_1__
export default function HomeScreen() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newPatientName, setNewPatientName] = useState("");
  const [isAddingPatient, setIsAddingPatient] = useState(false);
  const [recordingPatientId, setRecordingPatientId] = useState<string | null>(null);
  const [reportDetailId, setReportDetailId] = useState<string | null>(null);
  const [reportLibraryOpen, setReportLibraryOpen] = useState(false);
  const [expressionsOpen, setExpressionsOpen] = useState(false);

  // Cold start (1.3): the very first render fetches the workspace; the server creates the
  // demo session on that call and sets the cookie.
  const loadWorkspace = useCallback(async (options?: { isInitial?: boolean }) => {
    const timezone =
      typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
    const query = timezone ? `?timezone=${encodeURIComponent(timezone)}` : "";
    const response = await fetch(`/api/bootstrap${query}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") {
      setLoadFailed(true);
      toast.error(friendlyError(payload, "Could not load the demo workspace. Please try again."));
      return null;
    }
    const workspace = payload as BootstrapPayload;
    setData(workspace);
    setLoadFailed(false);
    if (options?.isInitial) {
      const lastPatientId = window.localStorage.getItem(LAST_PATIENT_KEY);
      setSelectedPatientId(
        lastPatientId && workspace.patients.some((patient) => patient.id === lastPatientId)
          ? lastPatientId
          : (workspace.patients[0]?.id ?? null),
      );
    }
    return workspace;
  }, []);

  // Cold-start bootstrap must run from the browser because the server sets the session cookie
  // on this call, and cookies can only be set in a route handler. Every setState inside
  // loadWorkspace happens after `await`, so the disabled rule is a false positive here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWorkspace({ isInitial: true });
  }, [loadWorkspace]);

  // Keep the switcher selection across reloads (1.5).
  useEffect(() => {
    if (selectedPatientId) window.localStorage.setItem(LAST_PATIENT_KEY, selectedPatientId);
  }, [selectedPatientId]);

  const selectedPatient = useMemo(
    () => data?.patients.find((patient) => patient.id === selectedPatientId) ?? null,
    [data, selectedPatientId],
  );

  const recordingPatient = useMemo(
    () => data?.patients.find((patient) => patient.id === recordingPatientId) ?? null,
    [data, recordingPatientId],
  );

  async function handleAddPatient(): Promise<void> {
    const displayName = newPatientName.trim();
    if (!displayName) return;
    setIsAddingPatient(true);
    try {
      const response = await fetch("/api/patients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) {
        toast.error(friendlyError(payload, "Could not add the patient. Please try again."));
        return;
      }
      const workspace = payload as BootstrapPayload;
      setData(workspace);
      setSelectedPatientId(workspace.patients.at(-1)?.id ?? null);
      setAddDialogOpen(false);
      setNewPatientName("");
      toast.success(`${displayName} added to this demo workspace.`);
    } finally {
      setIsAddingPatient(false);
    }
  }

  // Stage 1.7: replace the whole workspace with a fresh demo session in one action.
  async function handleResetDemo(): Promise<void> {
    setIsResetting(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetch(`/api/demo?timezone=${encodeURIComponent(timezone)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) {
        toast.error(friendlyError(payload, "Could not reset the demo. Please try again."));
        return;
      }
      const workspace = payload as BootstrapPayload;
      setData(workspace);
      setSelectedPatientId(workspace.patients[0]?.id ?? null);
      toast.success("Fresh demo workspace ready.");
    } finally {
      setIsResetting(false);
    }
  }

  if (loadFailed) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <TriangleAlert className="size-8 text-destructive" aria-hidden />
        <h1 className="text-lg font-semibold">VoiceCare could not load</h1>
        <p className="text-sm text-muted-foreground">
          The demo workspace is unavailable right now. Check your connection and try again.
        </p>
        <Button onClick={() => void loadWorkspace({ isInitial: true })}>Try again</Button>
      </main>
    );
  }

  if (!data) {
    return (
      <main aria-label="Loading VoiceCare" className="care-home">
        <header className="care-home-header">
          <CareBrand />
          <Skeleton className="h-10 w-24 rounded-full" />
        </header>

        <section className="care-patient-bar" aria-hidden="true">
          <Skeleton className="h-4 w-40" />
          <div className="flex w-full flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-11 w-28 rounded-full" />
              <Skeleton className="h-11 w-28 rounded-full" />
            </div>
            <Skeleton className="h-11 w-28 rounded-full" />
          </div>
        </section>

        <div className="care-home-grid" aria-hidden="true">
          <section className="care-capture">
            <Skeleton className="size-40 rounded-full sm:size-44" />
            <Skeleton className="mt-4 h-10 w-64 max-w-full" />
            <div className="mt-4 flex w-full flex-col items-center gap-2">
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-4 w-48 max-w-full" />
            </div>
            <Skeleton className="mt-6 h-12 w-52 max-w-full rounded-full" />
            <Skeleton className="mt-6 h-4 w-64 max-w-full" />
          </section>

          <section className="care-journal">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-9 w-32 rounded-md" />
            </div>
            <Skeleton className="mt-3 h-4 w-52 max-w-full" />
            <div className="mt-5 flex flex-col gap-2">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (recordingPatient) {
    return (
      <CareNoteWorkspace
        patientId={recordingPatient.id}
        patientName={recordingPatient.display_name}
        onCancel={() => setRecordingPatientId(null)}
        onSaved={(reportId) => {
          setRecordingPatientId(null);
          setReportLibraryOpen(true);
          setReportDetailId(reportId);
          toast.success("Care update saved.");
          void loadWorkspace();
        }}
      />
    );
  }

  if (reportLibraryOpen || reportDetailId) {
    return (
      <main className="care-home care-library">
        <header className="care-home-header">
          <Button variant="ghost" onClick={() => {
            if (reportDetailId) setReportDetailId(null);
            else setReportLibraryOpen(false);
          }}>
            <ArrowLeft data-icon="inline-start" aria-hidden />
            {reportDetailId ? "All updates" : "Care journal"}
          </Button>
          <CareBrand />
        </header>
        {reportDetailId ? (
          <>
            <div className="care-library-heading">
              <p className="eyebrow">{selectedPatient?.display_name ?? "Care journal"}</p>
              <h1>Care update</h1>
              <p>Confirmed details, measurements, and the original spoken account.</p>
            </div>
            <ReportDetailPanel reportId={reportDetailId} onBack={() => setReportDetailId(null)} />
          </>
        ) : (
          <>
            <div className="care-library-heading">
              <p className="eyebrow">{selectedPatient?.display_name ?? "Care journal"}</p>
              <h1>Saved updates</h1>
              <p>A clear history of what you have noticed and recorded.</p>
            </div>
            <div className="care-library-filter">
              <span className="text-sm font-medium">Showing updates for</span>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter updates by person">
                {data.patients.map((patient) => (
                  <Button key={patient.id} size="sm" variant={patient.id === selectedPatientId ? "default" : "outline"} onClick={() => setSelectedPatientId(patient.id)} aria-pressed={patient.id === selectedPatientId}>{patient.display_name}</Button>
                ))}
              </div>
            </div>
            <ReportHistory patientId={selectedPatient?.id ?? null} patientName={selectedPatient?.display_name ?? null} onSelect={(id) => { setReportLibraryOpen(true); setReportDetailId(id); }} />
          </>
        )}
      </main>
    );
  }

  // __SPLIT_2__
  return (
    <main className="care-home">
      <header className="care-home-header">
        <CareBrand />
        <nav className="flex flex-wrap items-center gap-1" aria-label="Workspace tools">
          <Button variant="outline" onClick={() => setExpressionsOpen(true)}>Phrases</Button>

        </nav>
      </header>

      <section className="care-patient-bar" aria-labelledby="patient-heading">
        <h2 id="patient-heading" className="text-sm font-medium">Who are you caring for?</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a patient">
            {data.patients.map((patient) => (
              <Button key={patient.id} variant={patient.id === selectedPatientId ? "default" : "outline"} className="h-auto min-h-11 max-w-full gap-2 whitespace-normal rounded-full py-2" onClick={() => setSelectedPatientId(patient.id)} aria-pressed={patient.id === selectedPatientId}>
                <Avatar className="size-7"><AvatarFallback>{initialsOf(patient.display_name)}</AvatarFallback></Avatar>
                <span>{patient.display_name}</span>
                {patient.id === selectedPatientId && <Check data-icon="inline-end" aria-hidden />}
              </Button>
            ))}
          </div>
          <Button variant="outline" onClick={() => setAddDialogOpen(true)}><Plus data-icon="inline-start" aria-hidden />Add person</Button>
        </div>
      </section>

      <div className="care-home-grid">
        <section className="care-capture" aria-labelledby="capture-heading">
          <div className="relative size-40 sm:size-44"><Orb className="absolute inset-0" colors={["#7c9463", "#c3cea8"]} agentState={null} /></div>
          <h1 id="capture-heading">{selectedPatient ? <>How is {selectedPatient.display_name}<br />doing today?</> : "Who are you caring for today?"}</h1>
          <p>Share how they’re feeling, what’s changed, or any readings you’ve taken.</p>
          <Button size="lg" className="mt-6 max-w-full h-auto min-h-12 whitespace-normal" onClick={() => selectedPatient && setRecordingPatientId(selectedPatient.id)} disabled={!selectedPatient}>
            <Mic data-icon="inline-start" aria-hidden />Start a voice update
          </Button>
          <div className="care-capture-foot"><span className="care-small-dot" />Speak freely. VoiceCare keeps up in real time.</div>
        </section>

        <section className="care-journal" aria-labelledby="history-heading">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="history-heading">Recent updates</h2><Button variant="ghost" size="sm" onClick={() => setReportLibraryOpen(true)}>All saved updates</Button></div>
          <p className="mt-2 text-sm text-muted-foreground">{selectedPatient ? `Showing updates for ${selectedPatient.display_name}` : "Choose a person to see their updates"}</p>
          <ReportHistory patientId={selectedPatient?.id ?? null} patientName={selectedPatient?.display_name ?? null} onSelect={(id) => { setReportLibraryOpen(true); setReportDetailId(id); }} />
        </section>
      </div>

      <footer className="care-home-footer"><span>Hackathon demo · Fictional information only · Not medical advice</span>          <Button variant="ghost" size="sm" onClick={() => void handleResetDemo()} disabled={isResetting}>
            <RotateCcw data-icon="inline-start" aria-hidden />{isResetting ? "Resetting..." : "Reset demo"}
          </Button></footer>

      <Dialog open={expressionsOpen} onOpenChange={setExpressionsOpen}>
        <DialogContent className="care-phrases-dialog max-h-[85dvh] overflow-y-auto p-6 sm:max-w-lg">
          <DialogHeader className="pr-10"><DialogTitle>Saved phrases</DialogTitle><DialogDescription>VoiceCare can remember phrases you explain, with your permission.</DialogDescription></DialogHeader>
          <RememberedPhrasesPanel />
        </DialogContent>
      </Dialog>

      <Dialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          setAddDialogOpen(open);
          if (!open) setNewPatientName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a person</DialogTitle>
            <DialogDescription>
              A first name is enough for the demo. You can always add more later.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-patient-name">Name</FieldLabel>
            <Input
              id="new-patient-name"
              value={newPatientName}
              placeholder="e.g. Mom"
              autoComplete="off"
              maxLength={60}
              onChange={(event) => setNewPatientName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAddPatient();
              }}
            />
          </Field>
          <DialogFooter>
            <Button
              onClick={() => void handleAddPatient()}
              disabled={isAddingPatient || newPatientName.trim().length === 0}
            >
              Add person
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
