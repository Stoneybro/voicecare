import { handle, jsonOk } from "@/lib/http";
import { getReport } from "@/lib/reports";
import { requireSession } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

// Full report: structured data plus original wording, including the revisions it superseded.
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    return jsonOk(await getReport(session, (await params).id));
  });
}
