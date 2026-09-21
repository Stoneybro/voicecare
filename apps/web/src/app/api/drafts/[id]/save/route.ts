import { saveConfirmedDraft } from "@/lib/drafts";
import { getReport } from "@/lib/reports";
import { handle, jsonOk, readJson } from "@/lib/http";
import { requireSession } from "@/lib/session";
import { draftSaveSchema } from "@voicecare/shared";

type Params = { params: Promise<{ id: string }> };

// Idempotent save of the confirmed revision (FR-044). Retries reuse the idempotency key and
// read back the existing report; reusing a key for different content is rejected (FR-046).
export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const draftId = (await params).id;
    const body = await readJson(request, draftSaveSchema);
    const saved = await saveConfirmedDraft(session, {
      draftId,
      expectedRevision: body.expected_revision,
      confirmedRevision: body.confirmed_revision,
      idempotencyKey: body.idempotency_key,
    });
    return jsonOk({ report: await getReport(session, saved.reportId), reused: saved.reused });
  });
}
