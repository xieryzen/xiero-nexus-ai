import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { publicUser, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  requireAdmin();
  const rows = db.select().from(users).orderBy(desc(users.createdAt)).all();
  return json({ users: rows.map(publicUser) });
});
