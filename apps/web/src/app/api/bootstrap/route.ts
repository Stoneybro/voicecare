import { bootstrapPayload } from "@/lib/bootstrap";
import { handle, jsonOk } from "@/lib/http";
import { bootstrapSession } from "@/lib/session";

// Stage 1.3: first visit creates the demo workspace — session, fictional caregiver, and two
// fictional patients in one transaction — and sets the session cookie. No login, no setup.
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const url = new URL(request.url);
    const session = await bootstrapSession(url.searchParams.get("timezone"));
    return jsonOk(await bootstrapPayload(session));
  });
}
