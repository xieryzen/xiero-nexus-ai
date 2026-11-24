import type {
  ChatMessage,
  ChatResult,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../adapters/types";
import { CONTINUE, DEFAULT_MAX_CONTINUATIONS, joinParts, wasCut } from "./whole";

/**
 * The tool loop: a model is asked, calls tools, reads their results and is
 * asked again, until it answers without a call or runs out of steps.
 *
 * Two things a model does that are not an answer are not taken for one
 * (v1.12.1). A reply that was cut at the length limit of one reply is asked
 * to go on, and the pieces are put together (whole.ts). A reply with nothing
 * in it, no text and no call, is asked again: after the tools were used, with
 * a word to go on. Either only so often.
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
  /**
   * For a tool whose every answer shows the same thing as it is now (a page
   * in a browser): what stays of an older answer once a newer one is there.
   * Without it, a model that works through many steps reads every earlier
   * state again with each step.
   */
  shorten?(result: string): string;
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
  /**
   * One model call. `continuing`: the reply before this one was cut at its
   * length limit, and this call asks the model to go on with it. `afterEmpty`:
   * the reply before this one had nothing in it, for this many times in a row;
   * whoever has another model to ask may ask that one.
   */
  chat(
    messages: ChatMessage[],
    opts: { tools: ToolDefinition[]; toolChoice: ToolChoice; continuing?: boolean; afterEmpty?: number },
  ): Promise<ChatResult>;
  /** The conversation so far: system prompt and task. It is not changed. */
  messages: ChatMessage[];
  tools: LoopTool[];
  /** Most model calls, the final answer included. A call that goes on with an answer that was cut is not one of them. */
  maxSteps: number;
  /** How often an answer that was cut at the model's length limit is asked to go on. */
  maxContinuations?: number;
  /** How often in a row a reply with nothing in it is asked again. */
  maxEmptyRetries?: number;
  /** Longest tool result handed to the model; the rest is cut with a note. */
  maxResultChars?: number;
  /**
   * Asked after each step: whether the tokens the work may use are used up.
   * The loop then asks once more, without tools, for the answer.
   */
  outOfTokens?(): boolean;
  /**
   * After each model call that was answered: the tokens that call used. So a
   * caller knows what the loop used as it goes, and when a later call fails.
   */
  onUsage?(promptTokens: number, completionTokens: number): void;
  /** Token count of a text, for providers that do not report usage. */
  estimateTokens(text: string): number;
  isCancelled?(): boolean;
  /** Before each model call. */
  onStep?(step: number): void;
  /** After each tool call. */
  onToolCall?(event: ToolCallEvent): void;
  /**
   * After the tool calls of a step: the tools as they are now, when a call
   * changed what there is to work with (a conversation in which a server was
   * handed over can work on it in the same answer). Null when nothing changed.
   */
  toolsChanged?(): LoopTool[] | null;
}

export type LoopStop = "answer" | "max_steps" | "tokens" | "cancelled";

export interface LoopResult {
  content: string;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  stopped: LoopStop;
  /** How often the answer was cut at the length limit of one reply and went on. */
  continued: number;
  /** Whether the answer is still cut: it went on as often as it may, or going on failed. */
  cut: boolean;
  /** How often a reply had nothing in it and was asked again. */
  emptied: number;
}

export const DEFAULT_MAX_EMPTY_RETRIES = 2;

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

/** After the tools were used, a reply came with nothing in it. */
const GO_ON =
  "Your last reply was empty. Go on with the task from where you are: make the next tool call now. " +
  "If everything is done, write your answer instead: what was done, and what was not.";

/** A call whose arguments ended where the reply was cut. */
const CUT_CALL =
  "This call was cut off at the length limit of one reply, before its arguments were complete, so nothing was run. " +
  "Make it again with less in it. To write a long file, write it in parts: the first part creates the file, " +
  "and each further part is added to its end.";

export async function runToolLoop(opts: LoopOptions): Promise<LoopResult> {
  const messages = [...opts.messages];
  let definitions = opts.tools.map((t) => t.definition);
  let byName = new Map(opts.tools.map((t) => [t.definition.name, t] as const));
  const maxResult = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const maxSteps = Math.max(1, opts.maxSteps);
  const maxContinuations = Math.max(0, opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS);
  const maxEmpty = Math.max(0, opts.maxEmptyRetries ?? DEFAULT_MAX_EMPTY_RETRIES);

  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  let steps = 0;
  // The model calls that count towards the most there may be: a call that
  // goes on with an answer that was cut belongs to the call it goes on from.
  let budget = 0;
  // The same call made again and again means the model is stuck.
  let lastKey = "";
  let repeats = 0;
  // An answer that was cut: what is there of it so far, and how often it went on.
  let carried = "";
  let continuing = false;
  let continued = 0;
  // Replies with nothing in them, in a row and in all.
  let emptyRun = 0;
  let emptied = 0;
  let wrapped = false;

  const done = (content: string, stopped: LoopStop, cut = false): LoopResult => ({
    content,
    steps,
    toolCalls,
    promptTokens,
    completionTokens,
    stopped,
    continued,
    cut,
    emptied,
  });

  const ask = async (toolChoice: ToolChoice, flags: { continuing?: boolean; afterEmpty?: number } = {}): Promise<ChatResult> => {
    steps++;
    opts.onStep?.(steps);
    const result = await opts.chat(messages, { tools: definitions, toolChoice, ...flags });
    const prompt = result.usage?.promptTokens ?? opts.estimateTokens(conversationText(messages));
    const completion =
      result.usage?.completionTokens ??
      opts.estimateTokens(result.content + JSON.stringify(result.toolCalls ?? ""));
    promptTokens += prompt;
    completionTokens += completion;
    opts.onUsage?.(prompt, completion);
    return result;
  };

  for (;;) {
    if (opts.isCancelled?.()) return done(carried, "cancelled");

    // The last step is kept for the answer: no more calls are allowed in it.
    const last = budget >= maxSteps - 1;
    if (last && budget > 0 && !wrapped) {
      messages.push({ role: "user", content: WRAP_UP });
      wrapped = true;
    }
    let result: ChatResult;
    try {
      result = await ask(last || definitions.length === 0 ? "none" : "auto", {
        ...(continuing ? { continuing: true } : {}),
        ...(emptyRun > 0 ? { afterEmpty: emptyRun } : {}),
      });
    } catch (err) {
      // Going on failed: what was written up to the limit stays, as an answer that is cut.
      if (continuing && carried.trim()) return done(carried, wrapped ? "max_steps" : "answer", true);
      throw err;
    }
    if (!continuing) budget++;

    const calls = last ? [] : (result.toolCalls ?? []);
    if (calls.length === 0) {
      const content = continuing ? joinParts(carried, result.content) : result.content;
      const cut = wasCut(result.finishReason);
      // Cut at the length limit of one reply: the model goes on from there.
      if (cut && result.content.trim() && continued < maxContinuations && !opts.isCancelled?.() && !opts.outOfTokens?.()) {
        messages.push({ role: "assistant", content: result.content, ...(result.raw ? { raw: result.raw } : {}) }, { role: "user", content: CONTINUE });
        carried = content;
        continuing = true;
        continued++;
        emptyRun = 0;
        continue;
      }
      // Nothing at all, no text and no call: that is no answer. Asked again.
      if (!content.trim() && emptyRun < maxEmpty && !opts.isCancelled?.()) {
        emptyRun++;
        emptied++;
        // After the tools were used, with a word to go on; before that, the request stands as it is.
        if (messages[messages.length - 1]?.role === "tool") messages.push({ role: "user", content: GO_ON });
        continue;
      }
      // Asked to go on, it wrote nothing more: what is there is still cut.
      return done(content, wrapped ? "max_steps" : "answer", content.trim() !== "" && (cut || (continuing && !result.content.trim())));
    }
    carried = "";
    continuing = false;
    emptyRun = 0;

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
        // Cut in the middle of a call: the same call again would be cut again.
        output = wasCut(result.finishReason) ? CUT_CALL : `The arguments were not a JSON object: ${call.invalidArguments.slice(0, 300)}`;
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
      if (tool?.shorten && !isError) {
        // The newest answer has the thing as it is now: the older ones keep only what they said had been done.
        for (let i = 0; i < messages.length; i++) {
          const earlier = messages[i]!;
          if (earlier.role !== "tool" || earlier.name !== call.name || earlier.isError) continue;
          const short = tool.shorten(earlier.content);
          if (short.length < earlier.content.length) messages[i] = { ...earlier, content: short };
        }
      }
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

    const now = opts.toolsChanged?.();
    if (now) {
      definitions = now.map((t) => t.definition);
      byName = new Map(now.map((t) => [t.definition.name, t] as const));
    }

    if (opts.isCancelled?.()) return done("", "cancelled");
    if (opts.outOfTokens?.()) {
      // No tokens left: one last call for the answer, without tools.
      if (budget < maxSteps) {
        messages.push({ role: "user", content: WRAP_UP });
        const final = await ask("none");
        return done(final.content, "tokens", wasCut(final.finishReason) && final.content.trim() !== "");
      }
      return done("", "tokens");
    }
  }
}
