import { handleAgentTool } from "@/lib/agent-tools";
import { ApiError, handle, jsonOk, readJson } from "@/lib/http";
import { requireSession } from "@/lib/session";
import { agentToolCallSchema } from "@voicecare/shared";

type Params = { params: Promise<{ id: string }> };

// The browser forwards each AssemblyAI tool call here. Arguments are validated against the
// same shared schema the tool definitions were generated from; failures return a 400 the
// agent can recover from instead of re-asking for everything.
export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const session = await requireSession();
    const call = await readJson(request, agentToolCallSchema);
    const raw = call.arguments as { expected_revision?: unknown };
    if (typeof raw.expected_revision !== "number" || raw.expected_revision <= 0) {
      throw new ApiError(400, "stale_revision", "The tool call did not name the draft revision it updates.");
    }
    return jsonOk(await handleAgentTool(session, (await params).id, call.name, call.arguments));
  });
}
