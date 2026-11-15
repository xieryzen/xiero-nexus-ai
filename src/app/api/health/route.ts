import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

/**
 * Whether this server can do its work: for uptime monitors, reverse proxies
 * and upgrade scripts. No sign-in is needed, so the answer says nothing else:
 * no version, no numbers.
 *
 * Reading from the database opens it, which applies the changes a new version
 * brings. So "ok" after an upgrade also means that the database was brought
 * up to date; 503 means it could not be opened, and the server log says why.
 */
export function GET(): Response {
  try {
    db.get(sql`select 1`);
    return Response.json({ status: "ok" }, { headers });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] health check: the database cannot be used:", err);
    return Response.json({ status: "error" }, { status: 503, headers });
  }
}
