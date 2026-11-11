import { handle, json } from "@/lib/api";
import { publicUser, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  return json({ user: publicUser(user) });
});
