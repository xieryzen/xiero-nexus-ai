import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { managesServers } from "@/lib/ssh/rules";
import { listCommands, serversFor } from "@/lib/ssh/servers";

export const dynamic = "force-dynamic";

/**
 * What was done on the machines, newest first: every command an agent ran
 * and how it ended, and every connection that was opened and closed.
 *
 *   ?server=<id>     one machine
 *   ?server=removed  the machines that are not registered any more (owners)
 *   ?before=<ms>     the page that starts at this moment (the time of the last row shown)
 *   ?limit=<n>       at most 200, 50 by default
 *
 * An owner reads all of it; an administrator, of the machines opened to
 * administrators.
 */
export const GET = handle(async (req) => {
  const user = requireAdmin();
  const url = new URL(req.url);
  const server = url.searchParams.get("server") ?? "";
  const before = Number(url.searchParams.get("before"));
  const limit = Number(url.searchParams.get("limit"));
  const owner = managesServers(user.role);
  const usable = serversFor(user).map((s) => s.id);
  if (server === "removed" && !owner) throw Errors.forbidden();
  if (server && server !== "removed" && !usable.includes(server)) throw Errors.notFound("Server not found");
  const commands = listCommands({
    serverId: server || undefined,
    // Without a machine named: everything for an owner, the machines they may use for anyone else.
    among: server || owner ? undefined : usable,
    before: Number.isFinite(before) && before > 0 ? before : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  return json({ commands });
});
