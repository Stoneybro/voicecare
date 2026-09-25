import { bootstrapPayload } from "@/lib/bootstrap";
import { handle, jsonOk } from "@/lib/http";
import { resetSession } from "@/lib/session";

// Stage 1.7: give the judge a clean demo workspace — the current session is invalidated and a
// fresh one (caregiver + two fictional patients) is created and set on the same response.
export async function DELETE(request: Request): Promise<Response> {
  return handle(async () => {
    const url = new URL(request.url);
    const session = await resetSession(url.searchParams.get("timezone"));
    return jsonOk(await bootstrapPayload(session));
  });
}
