import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function Home() {
  // The console is the product; send everyone through the auth gate.
  redirect("/dashboard");
}
