// AssemblyAI Voice Agent tool definitions, generated from the zod schemas in schemas.ts.
//
// The agent declares these inline in `session.tools` as client-side function tools, so every tool
// call lands on the VoiceCare backend, which validates the arguments against the same schema and
// owns the draft (spec/04 "Structured extraction contract").

import { z } from "zod";
import {
  askCaregiverArgsSchema,
  confirmPatientUnitArgsSchema,
  finishDraftArgsSchema,
  rememberExpressionArgsSchema,
  updateDraftArgsSchema,
} from "./schemas.ts";

export type AgentToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeout_seconds: number;
};

// AssemblyAI accepts plain JSON Schema for `parameters`. `z.toJSONSchema` produces draft 2020-12,
// which we relax for tool calling: extra keys are ignored by the backend validator, so the model is
// never blocked for adding a harmless field.
function toToolParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return relax(json) as Record<string, unknown>;
}

function relax(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => relax(item));
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties") continue;
    out[key] = relax(value);
  }
  return out;
}

const TOOL_TIMEOUT_SECONDS = 20;

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    type: "function",
    name: "update_draft",
    description:
      "Add or correct the measurements and observations the caregiver just described. Call this whenever you hear new information or a correction. Send only fields that changed, and always include the caregiver's exact words in source_text. The result tells you what is still unresolved.",
    parameters: toToolParameters(updateDraftArgsSchema),
    timeout_seconds: TOOL_TIMEOUT_SECONDS,
  },
  {
    type: "function",
    name: "ask_caregiver",
    description:
      "Register one clarification question before you speak it. Use kind='unit' when a measurement has no confirmed unit, kind='expression' when you want permission to remember a personal phrase, and 'value', 'time', 'subject', or 'generic' otherwise. Ask one question at a time.",
    parameters: toToolParameters(askCaregiverArgsSchema),
    timeout_seconds: TOOL_TIMEOUT_SECONDS,
  },
  {
    type: "function",
    name: "remember_expression",
    description:
      "Store a caregiver's personal phrase and its meaning. Call this only after ask_caregiver (kind='expression') and only after the caregiver explicitly answers yes or no. With confirmed_by_caregiver=false nothing is stored and the question is closed. Never call this to interpret a phrase; use update_draft for that.",
    parameters: toToolParameters(rememberExpressionArgsSchema),
    timeout_seconds: TOOL_TIMEOUT_SECONDS,
  },
  {
    type: "function",
    name: "confirm_patient_unit",
    description:
      "Apply the unit the caregiver just confirmed for a measurement, and optionally save it for future reports. Use remember_for_future_reports=true only when the caregiver agreed to remember it.",
    parameters: toToolParameters(confirmPatientUnitArgsSchema),
    timeout_seconds: TOOL_TIMEOUT_SECONDS,
  },
  {
    type: "function",
    name: "finish_draft",
    description:
      "Call this when you think the report is complete. The result contains the exact sentence to read back, whether the report can be saved, and what the caregiver must do next. Read the returned readback sentence, word for word, then wait.",
    parameters: toToolParameters(finishDraftArgsSchema),
    timeout_seconds: TOOL_TIMEOUT_SECONDS,
  },
];

export function agentToolByName(name: string): AgentToolDefinition | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

// Strong validation messages help the agent recover instead of re-asking for everything.
export function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
