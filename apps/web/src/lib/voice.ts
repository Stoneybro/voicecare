// AssemblyAI Voice Agent session support (spec/05 "AssemblyAI integration").
//
// The AssemblyAI API key never leaves the server (FR-011). The browser requests a short-lived
// token immediately before connecting, together with the session configuration it must open:
// the system prompt, transcription context, key terms, and the generated tool definitions.
// Tool calls are client-side function tools: the browser forwards each call to
// POST /api/drafts/:id/tool, which validates it against the same shared schema and owns the
// draft (spec/04 "Structured extraction contract").

import {
  AGENT_TOOLS,
  MEASUREMENT_LABELS,
  UNIT_SPEECH,
  type AgentToolDefinition,
  type KnownExpression,
} from "@voicecare/shared";
import type { PatientSummary } from "./session";

const TOKEN_ENDPOINT = "https://agents.assemblyai.com/v1/token";

export function isVoiceConfigured(): boolean {
  return Boolean(process.env.ASSEMBLYAI_API_KEY);
}

function tokenTtlSeconds(): number {
  const parsed = Number(process.env.VOICE_AGENT_TOKEN_TTL_SECONDS ?? "120");
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), 600)) : 120;
}

function maxSessionSeconds(): number {
  const parsed = Number(process.env.VOICE_AGENT_MAX_SESSION_SECONDS ?? "600");
  return Number.isFinite(parsed) ? Math.max(60, Math.min(Math.floor(parsed), 10_800)) : 600;
}

export type VoiceSessionConfig = {
  system_prompt: string;
  greeting: string;
  tools: AgentToolDefinition[];
  input: {
    format: { encoding: "audio/pcm" };
    keyterms: string[];
    transcription_mode: "balanced";
    transcription_prompt: string;
    language_codes: ["en"];
    turn_detection: {
      min_silence: number;
      max_silence: number;
      interrupt_response: true;
    };
  };
  output: {
    voice: string;
    format: { encoding: "audio/pcm" };
  };
};

export function voiceName(): string {
  return process.env.VOICE_AGENT_VOICE?.trim() || "alba";
}

export function buildSystemPrompt(input: {
  patientName: string;
  preferredUnits: Partial<Record<string, string>>;
  expressions: KnownExpression[];
  timeZone: string;
}): string {
  const unitLines = Object.entries(input.preferredUnits);
  const unitsSection =
    unitLines.length > 0
      ? unitLines.map(([type, unit]) => `- ${MEASUREMENT_LABELS[type as keyof typeof MEASUREMENT_LABELS] ?? type}: ${unit}`).join("\n")
      : "- none confirmed yet; ask when a measurement needs one";

  const expressionsSection =
    input.expressions.length > 0
      ? input.expressions
          .map((expression) => {
            const meaning = MEASUREMENT_LABELS[expression.measurement_type] ?? expression.measurement_type;
            const unit = expression.unit ? ` in ${expression.unit}` : "";
            return `- "${expression.phrase}" means ${meaning}${unit}, but only when the sentence is about a measurement`;
          })
          .join("\n")
      : "- none remembered yet";

  return [
    `You help a family caregiver record health observations for ${input.patientName} by voice.`,
    `Use short, plain sentences. The caregiver's timezone is ${input.timeZone}.`,
    ``,
    `Confirmed device units:`,
    unitsSection,
    ``,
    `Remembered personal expressions:`,
    expressionsSection,
    ``,
    `Rules:`,
    `- Send what you hear with update_draft, including the caregiver's exact words in source_text.`,
    `- Never choose a unit only because a number looks plausible. Ask with ask_caregiver first.`,
    `- Ask one short question at a time. Remembering "heart" as heart rate never turns "her heart hurts" into a number.`,
    `- When you think the report is complete, call finish_draft and read its readback sentence word for word, with units.`,
    `- Never say a report is saved. The caregiver saves it with a button in the app.`,
    `- Do not diagnose, predict, or advise treatment. For emergencies, say you cannot assess emergencies and direct the caregiver to local emergency services.`,
  ].join("\n");
}

export function buildTranscriptionPrompt(patientName: string): string {
  return [
    `Caregiver speech describing daily care for ${patientName}.`,
    `Listen carefully for spoken numbers, corrections such as "seventy, sorry, seventy-two",`,
    `blood pressure pairs such as "one thirty-eight over eighty-eight", units such as`,
    `millimoles per litre, milligrams per decilitre, degrees Celsius, beats per minute, and percent,`,
    `body locations such as left knee, food intake, mood, sleep, pain, and time phrases such as`,
    `this morning or yesterday.`,
  ].join(" ");
}

const BASE_KEY_TERMS = [
  "blood pressure",
  "blood glucose",
  "blood sugar",
  "temperature",
  "heart rate",
  "oxygen saturation",
  "millimoles per litre",
  "milligrams per decilitre",
  "degrees Celsius",
  "degrees Fahrenheit",
  "millimetres of mercury",
  "beats per minute",
];

export function buildKeyTerms(patientName: string, expressions: KnownExpression[]): string[] {
  const terms = new Set<string>([...BASE_KEY_TERMS, patientName]);
  for (const expression of expressions) terms.add(expression.phrase);
  return [...terms].slice(0, 50);
}

export function buildGreeting(patientName: string): string {
  return `Hello! Tell me what you observed for ${patientName} today, in your own words.`;
}

export function buildVoiceSession(input: {
  patient: PatientSummary;
  preferredUnits: Partial<Record<string, string>>;
  expressions: KnownExpression[];
  timeZone: string;
}): VoiceSessionConfig {
  return {
    system_prompt: buildSystemPrompt({
      patientName: input.patient.display_name,
      preferredUnits: input.preferredUnits,
      expressions: input.expressions,
      timeZone: input.timeZone,
    }),
    greeting: buildGreeting(input.patient.display_name),
    tools: AGENT_TOOLS,
    input: {
      format: { encoding: "audio/pcm" },
      keyterms: buildKeyTerms(input.patient.display_name, input.expressions),
      transcription_mode: "balanced",
      transcription_prompt: buildTranscriptionPrompt(input.patient.display_name),
      language_codes: ["en"],
      turn_detection: {
        min_silence: 900,
        max_silence: 2_500,
        interrupt_response: true,
      },
    },
    output: {
      voice: voiceName(),
      format: { encoding: "audio/pcm" },
    },
  };
}

export function unitSpeech(unit: string): string {
  return UNIT_SPEECH[unit] ?? unit;
}

export type MintedToken = {
  token: string;
  expires_in: number;
};

export class VoiceTokenError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Single-use browser token with a short redemption window (spec/06 "Access and secrets").
// expires_in_seconds is the redemption window, not the session length; the two are easy to
// confuse. Tokens are single-use: the browser fetches a fresh one before every connection.
export async function mintVoiceToken(): Promise<MintedToken> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new VoiceTokenError(503, "Voice sessions are not configured yet. Use the typed fallback instead.");
  }
  const expiresIn = tokenTtlSeconds();
  const url = new URL(TOKEN_ENDPOINT);
  url.searchParams.set("expires_in_seconds", String(expiresIn));
  url.searchParams.set("max_session_duration_seconds", String(maxSessionSeconds()));
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    console.error("[voicecare] voice token request failed", error);
    throw new VoiceTokenError(503, "The voice service could not be reached. Use the typed fallback instead.");
  }
  if (!response.ok) {
    console.error("[voicecare] voice token request rejected", response.status);
    throw new VoiceTokenError(502, "The voice service refused the session request. Use the typed fallback instead.");
  }
  const payload = (await response.json()) as { token?: unknown; access_token?: unknown };
  const token = typeof payload.token === "string" ? payload.token : typeof payload.access_token === "string" ? payload.access_token : null;
  if (!token) {
    console.error("[voicecare] voice token response had no token");
    throw new VoiceTokenError(502, "The voice service returned an unusable session. Use the typed fallback instead.");
  }
  return { token, expires_in: expiresIn };
}
