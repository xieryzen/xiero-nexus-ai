import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { seesSetup } from "@/lib/roles";
import { managesServers } from "@/lib/ssh/rules";
import { listCommands, serializeServer, serversFor } from "@/lib/ssh/servers";
import { keepaliveMs, openSessions } from "@/lib/ssh/sessions";
import { ServersManager } from "@/components/servers/servers-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Servers" };

export default function ServersPage() {
  const user = getCurrentUser();
  // How the installation is set up is shown to administrators (roles.ts: seesSetup).
  if (!user || !seesSetup(user.role)) redirect("/dashboard");
  const owner = managesServers(user.role);
  const rows = serversFor(user);
  const open = openSessions();
  return (
    <ServersManager
      initialServers={rows.map((row) => ({
        ...serializeServer(row),
        open: open.filter((s) => s.serverId === row.id).map(({ serverId: _serverId, ...rest }) => rest),
      }))}
      // An owner reads all of the log; an administrator, of the machines opened to administrators.
      // The machines of this page. What accounts handed over in conversations is listed apart, when an owner asks for it.
      initialLog={listCommands({ among: owner ? undefined : rows.map((r) => r.id), handed: false, limit: 30 })}
      canManage={owner}
      keepaliveSeconds={Math.round(keepaliveMs() / 1000)}
    />
  );
}
