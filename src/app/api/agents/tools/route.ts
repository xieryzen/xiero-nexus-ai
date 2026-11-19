import { TOOL_CATALOG, TOOL_GROUP_LABELS } from "@/lib/agent/catalog";
import { toolAvailable, toolStatus } from "@/lib/agent/tools";
import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { agentAllowedHosts } from "@/lib/web-fetch";

export const dynamic = "force-dynamic";

/** The tools agents can be given, and which of them work on this server as it is set up. */
export const GET = handle(async () => {
  requireAdmin(); // how the installation is set up is shown to administrators (roles.ts: seesSetup)
  const status = toolStatus();
  return json({
    groups: TOOL_GROUP_LABELS,
    tools: TOOL_CATALOG.map((tool) => ({ ...tool, available: toolAvailable(tool.name, status) })),
    sandbox: status.sandbox,
    search: status.search,
    browser: status.browser,
    // True when agents can only reach the hosts the administrator listed.
    hostsRestricted: agentAllowedHosts().length > 0,
  });
});
