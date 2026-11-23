import { handle, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireOwner } from "@/lib/auth";
import { ONLY_OWNER } from "@/lib/ssh/rules";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { fingerprint } from "@/lib/ssh/host-key";
import { limitConnections } from "@/lib/ssh/register";
import { getServer, registeredServer, logCommand, noteConnection, serializeServer } from "@/lib/ssh/servers";
import { SshProblem, checkServer, targetOf } from "@/lib/ssh/sessions";

export const dynamic = "force-dynamic";

/**
 * Sign in to a machine once and run one harmless command: whether what is
 * registered still works. The outcome is the answer (200) either way, so
 * that a failed check is shown where it was asked for.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const server = registeredServer(params.id!);
  if (!server) throw Errors.notFound("Server not found");
  limitConnections(user);
  const record = (result: "ok" | "error") =>
    audit({ actorUserId: user.id, action: "server.test", targetType: "server", targetId: server.id, metadata: { name: server.name, result }, ip, userAgent });
  try {
    const { output, durationMs } = await checkServer(targetOf(server));
    noteConnection(server.id, null);
    logCommand({ server, kind: "test", userId: user.id, command: "Check: signed in and ran one command", status: "ok", output, durationMs });
    record("ok");
    return json({ ok: true, output, durationMs, server: serializeServer(getServer(server.id) ?? server) });
  } catch (err) {
    if (!(err instanceof SshProblem)) throw err;
    noteConnection(server.id, err.message);
    // Signed in, and then no command: that is another finding than a sign-in that was refused.
    const signedIn = err.kind === "shell" || err.kind === "busy";
    logCommand({
      server,
      kind: "test",
      userId: user.id,
      command: signedIn ? "Check: signed in, and the command did not run" : "Check: could not sign in",
      status: "refused",
      output: err.message,
    });
    record("error");
    return json({
      ok: false,
      kind: err.kind,
      error: err.message,
      // The key the machine showed in place of the one that was accepted, for an owner to compare.
      shown: err.shownKey ? { hostKey: err.shownKey, fingerprint: fingerprint(err.shownKey) } : null,
      server: serializeServer(getServer(server.id) ?? server),
    });
  }
});
