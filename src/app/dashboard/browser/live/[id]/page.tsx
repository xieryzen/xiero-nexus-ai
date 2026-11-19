import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { liveOf } from "@/lib/browser/sessions";
import { seesSetup } from "@/lib/roles";
import { LiveView } from "@/components/browser/live-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "A page in the browser" };

/** A page of the browser that waits for a person: shown here, and acted on here. */
export default function LivePage({ params }: { params: { id: string } }) {
  const user = getCurrentUser();
  if (!user || !seesSetup(user.role)) redirect("/dashboard");
  return <LiveView id={params.id} initial={liveOf(params.id, user)} />;
}
