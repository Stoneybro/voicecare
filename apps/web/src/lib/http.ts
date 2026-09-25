// Shared HTTP helpers for route handlers: consistent JSON shapes, friendly errors, and no leaking
// of provider details or stack traces to the browser (spec/07).

import { ZodError, type ZodType } from "zod";
import { DatabaseNotConfiguredError, friendlyDatabaseMessage } from "./db";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonOk<T>(payload: T, init?: ResponseInit): Response {
  return Response.json(payload, { status: 200, ...init });
}

export function jsonError(error: ApiError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
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

// Route handlers wrap their body in this so unexpected failures become a readable message.
export async function handle(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error);
    if (error instanceof DatabaseNotConfiguredError) {
      return jsonError(new ApiError(503, "database_not_configured", friendlyDatabaseMessage(error)));
    }
    console.error("[voicecare] unhandled route error", error);
    return jsonError(new ApiError(500, "unexpected_error", friendlyDatabaseMessage(error)));
  }
}
