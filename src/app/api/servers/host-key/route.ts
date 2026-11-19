import { handle, json, parseBody } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { ONLY_OWNER } from "@/lib/ssh/rules";
import { Errors } from "@/lib/errors";
import { fingerprint, hostKeyFile, parseHostKey } from "@/lib/ssh/host-key";
import { limitConnections, problemError } from "@/lib/ssh/register";
import { hostProblem } from "@/lib/ssh/rules";
import { SshProblem, readHostKey } from "@/lib/ssh/sessions";
import { serverHostKeySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The host key a machine shows, for an owner to compare before the machine
 * is registered. Nothing is signed in to, and nothing is saved.
 */
export const POST = handle(async (req) => {
  const user = requireOwner(ONLY_OWNER);
  const body = await parseBody(req, serverHostKeySchema);
  const wrong = hostProblem(body.host);
  if (wrong) throw Errors.badRequest(wrong);
  limitConnections(user);
  try {
    const hostKey = await readHostKey(body.host, body.port ?? 22);
    const type = parseHostKey(hostKey)?.type ?? "";
    return json({ hostKey, type, fingerprint: fingerprint(hostKey), file: hostKeyFile(type) });
  } catch (err) {
    if (err instanceof SshProblem) throw problemError(err);
    throw err;
  }
});
