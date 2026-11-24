import { ChatScreen } from "./chat/screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

/**
 * Home: a new conversation. What used to be here, the numbers of the
 * installation, is on the admin console (/dashboard/admin); what an account
 * used is on its Usage page.
 */
export default function HomePage() {
  return <ChatScreen />;
}
