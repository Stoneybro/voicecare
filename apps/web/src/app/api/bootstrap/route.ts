import { bootstrapPayload } from "@/lib/bootstrap";
import { handle, jsonOk } from "@/lib/http";
import { bootstrapSession } from "@/lib/session";

// Create or restore the browser's anonymous demo session and fictional patient (spec/05).
// The client sends its IANA timezone so relative phrases resolve on the caregiver's day.
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const url = new URL(request.url);
    const session = await bootstrapSession(url.searchParams.get("timezone"));
    return jsonOk(await bootstrapPayload(session));
  });
}
