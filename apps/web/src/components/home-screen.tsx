"use client";

// Stage 1 home screen (spec/02 stages 1.1, 1.2, 1.5, 1.7): cold-start workspace with no login,
// a one-tap speak CTA around the voice orb, the patient switcher, an empty history state, and a
// demo reset. All data comes from GET /api/bootstrap; the browser never touches the database.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  HeartPulse,
  History,
  Mic,
  Plus,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import type { BootstrapPayload } from "@/lib/bootstrap";
import { Orb } from "@/components/ui/orb";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

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
      <main aria-label="Loading VoiceCare" className="mx-auto w-full max-w-md flex-1 p-4">
        <div className="mt-10 flex flex-col items-center gap-4">
          <Skeleton className="size-40 rounded-full" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="mt-10 space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      </main>
    );
  }

  // __SPLIT_2__
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-6 pb-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HeartPulse className="size-4" aria-hidden />
          </span>
          <span className="text-sm font-semibold tracking-tight">VoiceCare</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleResetDemo()}
          disabled={isResetting}
        >
          <RotateCcw data-icon="inline-start" aria-hidden />
          Reset demo
        </Button>
      </header>

      {/* Hero: one message, one primary action (spec/01 MVP bar). */}
      <section className="mt-8 flex flex-col items-center text-center">
        <div className="relative size-44">
          <Orb className="absolute inset-0" colors={["#64c8b8", "#a7e2d8"]} agentState={null} />
          <span
            aria-hidden
            className="voice-pulse pointer-events-none absolute inset-0 rounded-full"
          />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          {selectedPatient
            ? `How is ${selectedPatient.display_name} doing today?`
            : "Who are you caring for today?"}
        </h1>
        <p className="mt-2 max-w-72 text-sm text-muted-foreground">
          Speak naturally, like a voice note to yourself. VoiceCare turns it into a clear note
          for the doctor.
        </p>
        <Button size="lg" className="voice-pulse mt-5 h-11 rounded-full px-6 text-base">
          <Mic data-icon="inline-start" aria-hidden />
          Speak about {selectedPatient?.display_name ?? "your loved one"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Demo only — fictional patients, no real medical advice.
        </p>
      </section>
      {/* Patient switcher (1.5) + add patient (1.6). */}
      <section className="mt-10">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Who is this note about?
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data.patients.map((patient) => {
            const selected = patient.id === selectedPatientId;
            return (
              <button
                key={patient.id}
                type="button"
                onClick={() => setSelectedPatientId(patient.id)}
                aria-pressed={selected}
                className={cn(
                  "flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:bg-muted",
                )}
              >
                <Avatar className={cn("size-6", selected && "bg-primary-foreground/20")}>
                  <AvatarFallback className="text-[0.65rem]">
                    {initialsOf(patient.display_name)}
                  </AvatarFallback>
                </Avatar>
                {patient.display_name}
              </button>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus data-icon="inline-start" aria-hidden />
            Add person
          </Button>
        </div>
      </section>

      {/* History (1.2). Stage 5 replaces this empty state with real saved reports. */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            History
          </h2>
          <Badge variant="secondary">{data.reports_count} saved</Badge>
        </div>
        <Card className="mt-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="size-4 text-muted-foreground" aria-hidden />
              No notes yet
            </CardTitle>
            <CardDescription>
              Notes you save will appear here, newest first, ready to share with the doctor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5" aria-hidden />
              Demo session expires {new Date(data.session.expires_at).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </section>

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
          <div className="grid gap-2">
            <Label htmlFor="new-patient-name">Name</Label>
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
          </div>
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

