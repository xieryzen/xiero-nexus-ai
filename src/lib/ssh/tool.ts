import "server-only";
import type { Server } from "@/db/schema";
import { ToolError, type LoopTool } from "../agent/loop";
import {
  COMMAND_MAX_CHARS,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  SERVER_TOOL,
  commandLabel,
  earlierNote,
  resultText,
  timeoutSeconds,
  toolDescription,
  took,
} from "./rules";
import { commandsOfTask } from "./servers";
import { SshProblem, runOnServer } from "./sessions";

/** What the tool needs to know of the run and the task it works in. */
export interface ServerToolContext {
  runId: string;
  /** The project of the run. Null in a conversation, which has none. */
  projectId: string | null;
  /** The project's title; for a conversation, what the log calls it. */
  projectTitle: string;
  /** The account the project belongs to, or whose conversation it is. */
  userId: string | null;
  taskId: string;
  taskTitle: string;
  agentName: string | null;
  /** The machines the run may work on: the project's, checked when the task started. */
  servers: Pick<Server, "id" | "name" | "username" | "notes">[];
  isCancelled?: () => boolean;
  /** A note on the page of the run while a command is running. */
  progress?: (message: string) => void;
  /** Which attempt at the task this is. A new attempt starts over, and is told what the earlier ones ran. */
  attempt?: () => number;
  /** Keys the person handed over, for commands that name them (sessions.ts). */
  keys?: { fill(text: string): string; hide(text: string): string };
}

/**
 * The tool an agent runs commands on a server with. It names a machine of
 * its project, never an address: where a machine is and how it is signed in
 * to is registered by an owner, and is not the agent's to say.
 */
export function serverTool(ctx: ServerToolContext): LoopTool {
  const names = ctx.servers.map((s) => s.name);
  // The attempt at the task that made the last call: null before the first.
  let attempt: number | null = null;

  return {
    definition: {
      name: SERVER_TOOL,
      description: toolDescription(ctx.servers),
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command, as you would type it. Several lines and here-documents are fine.",
          },
          server: {
            type: "string",
            description:
              names.length === 1
                ? `The server's name. Leave it out: there is one, ${names[0]}.`
                : `The server's name: one of ${names.join(", ")}.`,
          },
          timeout_seconds: {
            type: "integer",
            description: `Seconds the command may take. Default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}.`,
          },
        },
        required: names.length === 1 ? ["command"] : ["command", "server"],
      },
    },
    async run(args) {
      const command = args.command;
      if (typeof command !== "string" || !command.trim()) throw new ToolError('"command" is required.');
      if (command.length > COMMAND_MAX_CHARS) {
        throw new ToolError(`A command can be at most ${COMMAND_MAX_CHARS} characters. Write a long file in parts.`);
      }
      if (command.includes("\u0000")) throw new ToolError("A command cannot hold a NUL character.");

      const wanted = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
      const server = wanted ? ctx.servers.find((s) => s.name === wanted) : ctx.servers.length === 1 ? ctx.servers[0] : undefined;
      if (!server) {
        throw new ToolError(
          wanted
            ? `This project has no server "${wanted}". Its servers: ${names.join(", ")}.`
            : `Say which server: ${names.join(", ")}.`,
        );
      }
      const seconds = timeoutSeconds(args.timeout_seconds);

      // An attempt that starts over is told what the task has already done on
      // the machines: starting over does not undo it. With its first call,
      // everything the task has run so far is from before it: an earlier
      // attempt, or the same task before the app was restarted.
      let before = "";
      const now = ctx.attempt?.() ?? 1;
      if (attempt !== now) {
        attempt = now;
        before = earlierNote(commandsOfTask(ctx.taskId));
      }

      const label = commandLabel(command, 60);
      ctx.progress?.(`${server.name}: ${label}`);
      try {
        const { result } = await runOnServer({
          runId: ctx.runId,
          serverId: server.id,
          context: {
            projectId: ctx.projectId,
            projectTitle: ctx.projectTitle,
            userId: ctx.userId,
            taskId: ctx.taskId,
            taskTitle: ctx.taskTitle,
            agentName: ctx.agentName,
          },
          command,
          timeoutSeconds: seconds,
          keys: ctx.keys,
          isCancelled: ctx.isCancelled,
          onProgress: (elapsed) => ctx.progress?.(`${server.name}: ${label} (${took(elapsed)})`),
        });
        const text = resultText(server.name, result);
        return before ? `${before}\n\n${text}` : text;
      } catch (err) {
        if (err instanceof SshProblem) throw new ToolError(before ? `${before}\n\n${err.forAgent}` : err.forAgent);
        throw err;
      }
    },
  };
}
