import { confirmDraftRevision } from "@/lib/drafts";
import { handle, jsonOk, readJson } from "@/lib/http";
import { requireSession } from "@/lib/session";
import { draftConfirmSchema } from "@voicecare/shared";

type Params = { params: Promise<{ id: string }> };

// Explicit confirmation bound to the current draft revision (FR-041). Rejected when the
// draft is not reviewable or still has unresolved required fields.
export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, draftConfirmSchema);
    return jsonOk(
      await confirmDraftRevision(session, {
        draftId: (await params).id,
        expectedRevision: body.expected_revision,
        method: body.method,
      }),
    );
  });
}
