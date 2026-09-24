import { submitTypedObservation } from "@/lib/agent-tools";
import { handle, jsonOk, readJson } from "@/lib/http";
import { requireSession } from "@/lib/session";
import { z } from "zod";

const textSchema = z.object({
  expected_revision: z.number().int().positive(),
  text: z.string().min(1).max(4000),
});

type Params = { params: Promise<{ id: string }> };

// Typed-observation fallback (FR-018): the same sentence goes through rule-based extraction
// locally and then the exact same backend resolution rules as voice input.
export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, textSchema);
    return jsonOk(
      await submitTypedObservation(session, (await params).id, {
        expectedRevision: body.expected_revision,
        text: body.text,
      }),
    );
  });
}
