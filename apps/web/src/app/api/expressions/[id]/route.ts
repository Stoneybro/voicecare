import { softDeleteExpression, updateExpression } from "@/lib/expressions";
import { handle, jsonOk, readJson } from "@/lib/http";
import { requireSession } from "@/lib/session";
import { expressionPatchSchema } from "@voicecare/shared";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const body = await readJson(request, expressionPatchSchema);
    return jsonOk(await updateExpression(session.caregiverId, (await params).id, body));
  });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    await softDeleteExpression(session.caregiverId, (await params).id);
    return jsonOk({ deleted: true });
  });
}
