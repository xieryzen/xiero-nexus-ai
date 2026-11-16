/**
 * What a project run reports while it runs. Types only, so that the server
 * and the project page can share them.
 */
import type { PROJECT_STATES, TASK_STATES } from "@/db/schema";
import type { TaskKind } from "@/lib/creative/prompt";
import type { MediaAssetDTO } from "@/lib/media/dto";

export type ProjectState = (typeof PROJECT_STATES)[number];
export type TaskState = (typeof TASK_STATES)[number];

/** A tool call an agent made, as shown under its task. */
export interface ToolCallNote {
  step: number;
  name: string;
  /** The arguments in one line, shortened. */
  summary: string;
  isError: boolean;
  durationMs: number;
}

export type RunEvent =
  | { type: "status"; status: ProjectState }
  | {
      type: "plan";
      tasks: {
        /** The task's id, for looking up what it did (its tool calls). */
        id?: string;
        seq: number;
        title: string;
        agent: string;
        dependsOn: number[];
        kind: TaskKind;
      }[];
    }
  | {
      type: "task";
      seq: number;
      title: string;
      status: TaskState;
      agent: string | null;
      artifact?: string | null;
      error?: string | null;
      tokens?: number;
      /** The media a creative task generated. */
      assets?: MediaAssetDTO[];
      /** Model calls and tool calls the task took, for an agent with tools. */
      steps?: number;
      toolCalls?: number;
    }
  // A running task's progress note. Also keeps the stream alive during a long wait.
  // `full` says the same with the model that does it, for those who are shown
  // the setup; the stream hands out one of the two (for-viewer.ts).
  | { type: "progress"; seq: number; message: string; full?: string }
  // A tool call an agent made in a running task.
  | { type: "tool"; seq: number; call: ToolCallNote }
  | { type: "final"; deliverable: string }
  | { type: "review"; notes: string }
  | { type: "budget"; used: number; limit: number }
  | { type: "error"; message: string }
  | { type: "done"; status: ProjectState };
