import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, type Project, type User } from "@/db/schema";
import { Errors } from "./errors";
import { isAdminRole } from "@/lib/roles";
import { assertMayOperateAccounts } from "./browser/accounts";
import { assertMayOperate as assertMayOperateServers } from "./ssh/servers";

/**
 * Whoever tells the agents of a project what to do can have anything done on
 * the servers it names and with the site accounts it names. So a project is
 * run, changed, scheduled and approved, and its workspace written, only by
 * an account whose own projects may use every one of them. Anyone else who
 * may open the project can still read it.
 */
export function assertMayOperate(project: Pick<Project, "id">, user: Pick<User, "role">): void {
  assertMayOperateServers(project, user);
  assertMayOperateAccounts(project, user);
}

/** Load a project the user is allowed to see (owner or admin), or throw. */
export function loadOwnedProject(id: string, user: User): Project {
  const p = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw Errors.notFound("Project not found");
  if (p.createdBy !== user.id && !isAdminRole(user.role)) throw Errors.forbidden();
  return p;
}

/**
 * Load a project to run it, change it or schedule it. Whoever does that tells
 * its agents what to do; where the project names servers or site accounts,
 * that is anything on them. So besides being allowed to see the project,
 * the account has to be one whose own projects may use every one it names.
 */
export function loadOperableProject(id: string, user: User): Project {
  const p = loadOwnedProject(id, user);
  assertMayOperate(p, user);
  return p;
}
