import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { unixSeconds, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/** The user's projects (all projects, for an administrator's key). */
export const GET = v1("projects", (_req, { caller }) => {
  const rows =
    caller.user.role === "admin"
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(200).all()
      : db
          .select()
          .from(projects)
          .where(eq(projects.createdBy, caller.user.id))
          .orderBy(desc(projects.updatedAt))
          .limit(200)
          .all();
  return NextResponse.json({
    object: "list",
    data: rows.map((p) => ({
      id: p.id,
      object: "project",
      title: p.title,
      goal: p.goal,
      status: p.status,
      created_at: unixSeconds(p.createdAt),
      updated_at: unixSeconds(p.updatedAt),
    })),
  });
});
