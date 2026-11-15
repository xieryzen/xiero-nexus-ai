import { NextResponse } from "next/server";
import { publicModelNames } from "@/lib/public-api/openai-format";
import { apiModels, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/** The models this key may use, under the names the other endpoints take. */
export const GET = v1(null, (_req, { caller }) => {
  const list = apiModels(caller);
  const names = publicModelNames(list);
  return NextResponse.json({
    object: "list",
    data: list
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
