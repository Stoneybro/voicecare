import { bootstrapPayload } from "@/lib/bootstrap";
import { handle, jsonOk, readJson } from "@/lib/http";
import { resetSession } from "@/lib/session";
import { z } from "zod";

const resetSchema = z.object({ timezone: z.string().min(1).nullish() });

// Abandon the current demo workspace and issue a clean isolated session (spec/06
// "Demo retention and reset"). The new session cannot access the old data.
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(request, resetSchema).catch(() => ({ timezone: null as string | null }));
    const session = await resetSession(body.timezone ?? null);
    return jsonOk(await bootstrapPayload(session));
  });
}
