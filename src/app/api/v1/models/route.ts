import { NextResponse } from "next/server";
import { publicModelNames } from "@/lib/public-api/openai-format";
import { AUTO_MODEL, apiModels, autoCapabilities, v1 } from "@/lib/public-api/server";
import { seesSetup } from "@/lib/roles";

export const dynamic = "force-dynamic";

/**
 * The models this key may use, under the names the other endpoints take. A
 * model that failed its last check is not listed until a check passes again;
 * a request that names it is still passed on.
 *
 * A key of an account that is not shown the setup gets one name, "auto": the
 * model is chosen for it, and the list says what kinds of work that covers.
 */
export const GET = v1(null, (_req, { caller }) => {
  if (!seesSetup(caller.user.role)) {
    const capabilities = autoCapabilities();
    return NextResponse.json({
      object: "list",
      data:
        capabilities.length === 0
          ? []
          : [{ id: AUTO_MODEL, object: "model", owned_by: "this installation", name: "Chosen for you", capabilities }],
    });
  }
  const list = apiModels(caller);
  const names = publicModelNames(list);
  return NextResponse.json({
    object: "list",
    data: list
      .filter((m) => !m.failing)
      .map((m) => ({
        id: names.get(m.rowId) ?? m.rowId,
        object: "model",
        owned_by: m.providerName,
        name: m.displayName ?? m.modelId,
        capabilities: m.capabilities,
        context_window: m.contextWindow,
        row_id: m.rowId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
});
