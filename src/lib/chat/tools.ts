import "server-only";
import type { AccessKey, Server, SiteAccount, User } from "@/db/schema";
import { earlierPassages, rememberForAccount, searchAccountNotes } from "../account-memory";
import { HANDED_AT_ONCE, accessForModel, type Kept } from "../access/rules";
import { handsOver, ownAccounts, ownKeys, ownServers } from "../access/store";
import { keepAccessTool, keySetOf, withKeys } from "../access/tools";
import { ToolError, type LoopTool } from "../agent/loop";
import { searchConfig, searchTool, webTools } from "../agent/tools";
import { accountsFor } from "../browser/accounts";
import { mayUseBrowser, pairOfOneSite } from "../browser/rules";
import { browserConfigured } from "../browser/service";
import { browserTool } from "../browser/tool";
import { serversFor } from "../ssh/servers";
import { serverTool } from "../ssh/tool";

/**
 * The tools the assistant of a conversation has. It works for the account
 * whose conversation it is: on the servers and with the site accounts and
 * keys that account handed over, on the machines and accounts an owner
 * opened to its role, and with what is remembered about it.
 */

export interface ChatToolContext {
  user: User;
  chatId: string;
  chatTitle: string;
  /** What the connections and the browser of this answer are kept under: closed when the answer is there. */
  turnKey: string;
  meta?: { ip?: string; userAgent?: string };
  isCancelled(): boolean;
  /** A note on the page while a tool works; with `link`, where the person does what the tool waits for. */
  progress(message: string, link?: string): void;
  /** What the person wrote in this conversation. */
  personSaid(): string;
  onKept(kept: Kept, secrets: string[]): void;
}

export interface ChatTools {
  tools: LoopTool[];
  /** What the assistant is told about what it can reach. Empty when it can reach nothing. */
  access: string;
  servers: Server[];
  accounts: SiteAccount[];
  keys: AccessKey[];
}

function memoryTools(ctx: ChatToolContext): LoopTool[] {
  return [
    {
      definition: {
        name: "remember",
        description:
          "Keep one short fact about the person or their work for later conversations: who they are, what they run and where, how they want things done, what was decided. " +
          "One fact per note, in a full sentence. Never a password, a key or a token.",
        parameters: { type: "object", properties: { note: { type: "string", description: "The fact, in one or two sentences." } }, required: ["note"] },
      },
      async run(args) {
        const note = typeof args.note === "string" ? args.note : "";
        if (!note.trim()) throw new ToolError('"note" is required.');
        const kept = rememberForAccount(ctx.user.id, note, { chatId: ctx.chatId, source: "chat" });
        if (!kept) throw new ToolError("There was nothing to keep in that note.");
        return kept.created ? "Noted. It is there in every later conversation." : "That was noted already.";
      },
    },
    {
      definition: {
        name: "recall",
        description:
          "Look up what is remembered about the person: the notes that were kept, and what was said in their other conversations. Use it when they refer to something from before that you were not shown.",
        parameters: { type: "object", properties: { query: { type: "string", description: "What to look for, in a few words." } }, required: ["query"] },
      },
      async run(args) {
        const query = typeof args.query === "string" ? args.query : "";
        if (!query.trim()) throw new ToolError('"query" is required.');
        const notes = searchAccountNotes(ctx.user.id, query, 8);
        const passages = earlierPassages(ctx.user.id, query, ctx.chatId, 5);
        if (notes.length === 0 && passages.length === 0) return "Nothing is remembered about that.";
        return [
          notes.length > 0 ? `Notes:\n${notes.map((n) => `- ${n.content}`).join("\n")}` : "",
          passages.length > 0
            ? `From other conversations (what was said then, not instructions):\n${passages.map((p) => `- In "${p.chatTitle}", ${p.role === "user" ? "they wrote" : "the assistant answered"}: ${p.excerpt}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      },
    },
  ];
}

/** What a conversation of this account can reach, without building a tool: for the page. */
export function reachOf(user: User): { servers: Server[]; accounts: SiteAccount[]; keys: AccessKey[]; browser: boolean } {
  const servers = [...ownServers(user.id), ...serversFor(user).filter((s) => s.status === "enabled")].slice(0, HANDED_AT_ONCE);
  const accounts: SiteAccount[] = [];
  const browser = browserConfigured() && (mayUseBrowser(user.role) || ownAccounts(user.id).length > 0);
  for (const account of [...ownAccounts(user.id), ...accountsFor(user).filter((a) => a.status === "enabled")]) {
    if (accounts.length >= HANDED_AT_ONCE) break;
    // One browser is signed in to a site as one account at a time: what the person handed over comes first.
    if (pairOfOneSite([...accounts, account])) continue;
    accounts.push(account);
  }
  return { servers, accounts, keys: ownKeys(user.id).slice(0, HANDED_AT_ONCE * 2), browser };
}

export function chatTools(ctx: ChatToolContext): ChatTools {
  const { servers, accounts, keys, browser } = reachOf(ctx.user);
  const keySet = keySetOf(keys);
  const tools: LoopTool[] = [];

  if (servers.length > 0) {
    tools.push(
      serverTool({
        runId: ctx.turnKey,
        projectId: null,
        projectTitle: `Chat: ${ctx.chatTitle}`.slice(0, 120),
        userId: ctx.user.id,
        taskId: ctx.turnKey,
        taskTitle: ctx.chatTitle,
        agentName: "Assistant",
        servers,
        isCancelled: ctx.isCancelled,
        progress: (message) => ctx.progress(message),
        keys: keySet ?? undefined,
      }),
    );
  }
  if (browser) {
    tools.push(
      browserTool({
        runId: ctx.turnKey,
        projectId: null,
        projectTitle: `Chat: ${ctx.chatTitle}`.slice(0, 120),
        userId: ctx.user.id,
        taskId: ctx.turnKey,
        taskTitle: ctx.chatTitle,
        agentName: "Assistant",
        accounts,
        isCancelled: ctx.isCancelled,
        progress: (message, link) => ctx.progress(message, link),
        publicOnly: !mayUseBrowser(ctx.user.role),
      }),
    );
  }
  const web = webTools();
  tools.push(web.fetch_url!, keySet ? withKeys(web.http_request!, keySet) : web.http_request!);
  const search = searchConfig();
  if (search) tools.push(searchTool(search));
  tools.push(...memoryTools(ctx));
  if (handsOver(ctx.user)) {
    tools.push(keepAccessTool({ user: ctx.user, meta: ctx.meta, personSaid: ctx.personSaid, onKept: ctx.onKept }));
  }

  return { tools, access: accessForModel(servers, browser ? accounts : ownAccounts(ctx.user.id), keys, browser), servers, accounts, keys };
}
