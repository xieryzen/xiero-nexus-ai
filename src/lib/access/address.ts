import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type Server } from "@/db/schema";
import { AppError } from "../errors";
import { isPrivateIp } from "../ssrf";

/** Hosts on a private network that the installation lets agents reach all the same. */
function privateHostsAllowed(): string[] {
  return (process.env.AGENT_HTTP_PRIVATE_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Where to connect for a machine that someone other than an owner handed
 * over: an address on the public internet. An owner registers any machine
 * on the Servers page; anyone else's conversation must not make the app
 * reach into the network it runs in. The name is looked up once and the
 * address is what is connected to, so that a name cannot lead somewhere else
 * in between. Throws an AppError that is safe to show.
 */
export async function publicAddressOf(host: string): Promise<string> {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (privateHostsAllowed().includes(name)) return name;
  const refused = new AppError(400, "blocked_host", `${name} is on a private network, which a conversation cannot make the app reach. An owner can register it on the Servers page.`);
  if (isIP(name)) {
    if (isPrivateIp(name)) throw refused;
    return name;
  }
  if (name === "localhost" || name.endsWith(".localhost")) throw refused;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(name, { all: true });
  } catch {
    throw new AppError(400, "dns_error", `Could not find the host ${name}.`);
  }
  if (addresses.length === 0) throw new AppError(400, "dns_error", `Could not find the host ${name}.`);
  if (addresses.some((a) => isPrivateIp(a.address))) throw refused;
  return addresses[0]!.address;
}

/**
 * The address to connect to for a machine. One an owner registered, or
 * handed over: as it is written. One that anyone else handed over: looked
 * up and checked each time, since a name can point somewhere else later.
 */
export async function connectHostOf(server: Pick<Server, "host" | "ownerId">): Promise<string> {
  if (!server.ownerId) return server.host;
  const role = db.select({ role: users.role }).from(users).where(eq(users.id, server.ownerId)).get()?.role ?? null;
  if (role === "owner") return server.host;
  return publicAddressOf(server.host);
}
