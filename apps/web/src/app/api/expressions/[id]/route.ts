import { getSql } from "@/lib/db";
import { ApiError, handle, jsonOk } from "@/lib/http";
import { requireSession } from "@/lib/session";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const rows = await getSql()`
      update personal_expressions
      set deleted_at = now(), updated_at = now()
      where id = ${id} and caregiver_id = ${session.caregiverId} and deleted_at is null
      returning id
    `;
    if (rows.length === 0) throw new ApiError(404, "expression_not_found", "That remembered phrase could not be found.");
    return jsonOk({ expression_id: id, deleted: true });
  });
}
