import type {
  ChatMessage,
  ChatResult,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../adapters/types";

/**
 * The tool loop: a model is asked, calls tools, reads their results and is
 * asked again, until it answers without a call or runs out of steps.
 *
 * Pure: the model and the tools are passed in, so the loop can be unit-tested
 * with fakes, without a provider or a database.
 */

/** Thrown by a tool to tell the model what went wrong. The loop goes on. */
export class ToolError extends Error {}

export interface LoopTool {
  definition: ToolDefinition;
  /** Runs the tool. Resolves to what the model reads; throws ToolError to report a failure. */
  run(args: Record<string, unknown>): Promise<string>;
}

export interface ToolCallEvent {
  step: number;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface LoopOptions {
  /** One model call. */
  chat(
    messages: ChatMessage[],
    opts: { tools: ToolDefinition[]; toolChoice: ToolChoice },
  ): Promise<ChatResult>;
  /** The conversation so far: system prompt and task. It is not changed. */
  messages: ChatMessage[];
  tools: LoopTool[];
  /** Most model calls, the final answer included. */
  maxSteps: number;
  /** Longest tool result handed to the model; the rest is cut with a note. */
  maxResultChars?: number;
  /** Stop when this many tokens are used. */
  tokenBudget?: number;
  /** Token count of a text, for providers that do not report usage. */
  estimateTokens(text: string): number;
  isCancelled?(): boolean;
  /** Before each model call. */
  onStep?(step: number): void;
  /** After each tool call. */
  onToolCall?(event: ToolCallEvent): void;
}

export type LoopStop = "answer" | "max_steps" | "budget" | "cancelled";

export interface LoopResult {
  content: string;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  stopped: LoopStop;
}

export const DEFAULT_MAX_RESULT_CHARS = 12_000;

/** Cut a long tool result, saying that it was cut and by how much. */
export function clipResult(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[cut: ${text.length - max} more characters were not shown]`;
}

function conversationText(messages: ChatMessage[]): string {
  return messages
    .map((m) => m.content + (m.toolCalls ? JSON.stringify(m.toolCalls.map((c) => c.arguments)) : ""))
    .join("\n");
}

function callKey(call: ToolCall): string {
  return `${call.name}:${call.invalidArguments ?? JSON.stringify(call.arguments)}`;
}

const WRAP_UP =
  "You have no tool calls left. Give your final deliverable for the task now, from what you have. " +
  "If something could not be finished, say exactly what.";

export async function runToolLoop(opts: LoopOptions): Promise<LoopResult> {
  const messages = [...opts.messages];
  const definitions = opts.tools.map((t) => t.definition);
  const byName = new Map(opts.tools.map((t) => [t.definition.name, t] as const));
  const maxResult = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const maxSteps = Math.max(1, opts.maxSteps);

  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  let steps = 0;
  // The same call made again and again means the model is stuck.
  let lastKey = "";
  let repeats = 0;

  const done = (content: string, stopped: LoopStop): LoopResult => ({
    content,
    steps,
    toolCalls,
    promptTokens,
    completionTokens,
    stopped,
  });

  const ask = async (toolChoice: ToolChoice): Promise<ChatResult> => {
    steps++;
    opts.onStep?.(steps);
    const result = await opts.chat(messages, { tools: definitions, toolChoice });
    promptTokens += result.usage?.promptTokens ?? opts.estimateTokens(conversationText(messages));
    completionTokens +=
      result.usage?.completionTokens ??
      opts.estimateTokens(result.content + JSON.stringify(result.toolCalls ?? ""));
    return result;
  };

  for (;;) {
    if (opts.isCancelled?.()) return done("", "cancelled");

    // The last step is kept for the answer: no more calls are allowed in it.
    const last = steps >= maxSteps - 1;
    const afterTools = last && steps > 0;
    if (afterTools) messages.push({ role: "user", content: WRAP_UP });
    const result = await ask(last || definitions.length === 0 ? "none" : "auto");

    const calls = last ? [] : (result.toolCalls ?? []);
    if (calls.length === 0) return done(result.content, afterTools ? "max_steps" : "answer");

    messages.push({
      role: "assistant",
      content: result.content,
      toolCalls: calls,
      raw: result.raw,
    });

    for (const call of calls) {
      const started = Date.now();
      let output: string;
      let isError = false;
      const key = callKey(call);
      repeats = key === lastKey ? repeats + 1 : 0;
      lastKey = key;
      const tool = byName.get(call.name);

      if (!tool) {
        isError = true;
        output = `There is no tool named "${call.name}". The tools are: ${[...byName.keys()].join(", ")}.`;
      } else if (call.invalidArguments !== undefined) {
        isError = true;
        output = `The arguments were not a JSON object: ${call.invalidArguments.slice(0, 300)}`;
      } else if (repeats >= 2) {
        isError = true;
        output =
          "You have made this exact call three times in a row. Use the result you already have, or do something else.";
      } else if (opts.isCancelled?.()) {
        isError = true;
        output = "The run was cancelled.";
      } else {
        try {
          output = await tool.run(call.arguments);
        } catch (err) {
          isError = true;
          output =
            err instanceof ToolError
              ? err.message
              : err instanceof Error && err.name === "AppError"
                ? err.message
                : "The tool failed unexpectedly.";
        }
      }
      output = clipResult(output, maxResult);
      toolCalls++;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: output,
        isError,
      });
      opts.onToolCall?.({
        step: steps,
        name: call.name,
        arguments: call.arguments,
        result: output,
        isError,
        durationMs: Date.now() - started,
      });
    }

    if (opts.isCancelled?.()) return done("", "cancelled");
    if (opts.tokenBudget !== undefined && promptTokens + completionTokens >= opts.tokenBudget) {
      // Out of budget: one last call for the answer, without tools.
      if (steps < maxSteps) {
        messages.push({ role: "user", content: WRAP_UP });
        const final = await ask("none");
        return done(final.content, "budget");
      }
      return done("", "budget");
    }
  }
}
