// Shared HTTP helpers for route handlers: consistent JSON shapes, friendly errors, and no leaking
// of provider details or stack traces to the browser.

import { ZodError, type ZodType } from "zod";
import type { DraftRecord } from "@voicecare/shared";
import { DatabaseNotConfiguredError, friendlyDatabaseMessage } from "./db";

export class ApiError extends Error {
  status: number;
  code: string;
  draft?: DraftRecord | null;

  constructor(status: number, code: string, message: string, draft?: DraftRecord | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.draft = draft ?? undefined;
  }
}

export function jsonOk<T>(payload: T, init?: ResponseInit): Response {
  return Response.json(payload, { status: 200, ...init });
}

export function jsonError(error: ApiError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message }, draft: error.draft ?? null },
    { status: error.status },
  );
}

export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "The request body was not valid JSON.");
  }
  return parseWith(schema, payload);
}

export function parseWith<T>(schema: ZodType<T>, payload: unknown): T {
  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const path = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
      throw new ApiError(400, "invalid_request", `${path}${first?.message ?? "The request was not valid."}`);
    }
    throw error;
  }
}

export function requireTrue(value: boolean, code: string, message: string): void {
  if (!value) throw new ApiError(400, code, message);
}

// Route handlers wrap their body in this so that unexpected failures become a readable message.
export async function handle(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error);
    if (error instanceof DatabaseNotConfiguredError) {
      return jsonError(new ApiError(503, "database_not_configured", friendlyDatabaseMessage(error)));
    }
    console.error("[voicecare] unhandled route error", error);
    return jsonError(
      new ApiError(500, "unexpected_error", friendlyDatabaseMessage(error)),
    );
  }
}

export function parseDateRange(url: URL): { from: string | null; to: string | null } {
  const parse = (value: string | null): string | null => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };
  return { from: parse(url.searchParams.get("from")), to: parse(url.searchParams.get("to")) };
}
