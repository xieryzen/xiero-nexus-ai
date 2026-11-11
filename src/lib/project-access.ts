import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, type Project, type User } from "@/db/schema";
import { Errors } from "./errors";

/** Load a project the user is allowed to see (owner or admin), or throw. */
export function loadOwnedProject(id: string, user: User): Project {
  const p = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw Errors.notFound("Project not found");
  if (p.createdBy !== user.id && user.role !== "admin") throw Errors.forbidden();
  return p;
}
