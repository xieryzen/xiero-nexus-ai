/**
 * The tools an agent can be given (v1.5). Pure: the list, what each one is
 * for and what it needs, shared by the server and the agent form.
 */

export const TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
  "fetch_url",
  "http_request",
  "web_search",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that are not chosen one by one: they come with knowledge, memory and skills. */
export const IMPLIED_TOOL_NAMES = ["search_knowledge", "remember", "recall", "read_skill"] as const;
export type ImpliedToolName = (typeof IMPLIED_TOOL_NAMES)[number];

export type ToolGroup = "workspace" | "execution" | "web";

export interface ToolInfo {
  name: ToolName;
  label: string;
  group: ToolGroup;
  /** One line for the agent form. */
  summary: string;
  /** What must be configured on the server for the tool to work. */
  needs?: "sandbox" | "search";
}

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  workspace: "Project workspace",
  execution: "Code execution",
  web: "Web and APIs",
};

export const TOOL_CATALOG: readonly ToolInfo[] = [
  { name: "list_files", label: "List files", group: "workspace", summary: "See which files the project workspace has." },
  { name: "read_file", label: "Read files", group: "workspace", summary: "Read a workspace file." },
  { name: "write_file", label: "Write files", group: "workspace", summary: "Create or replace a workspace file." },
  { name: "edit_file", label: "Edit files", group: "workspace", summary: "Replace a piece of text in a workspace file." },
  { name: "delete_file", label: "Delete files", group: "workspace", summary: "Remove a workspace file." },
  {
    name: "run_command",
    label: "Run commands",
    group: "execution",
    summary: "Run tests or a build on the workspace files, in the sandbox runner.",
    needs: "sandbox",
  },
  { name: "fetch_url", label: "Read web pages", group: "web", summary: "Fetch a public page and read its text." },
  {
    name: "http_request",
    label: "Call HTTP APIs",
    group: "web",
    summary: "Send a request to a public HTTP API and read the answer.",
  },
  {
    name: "web_search",
    label: "Search the web",
    group: "web",
    summary: "Search the web through the configured search provider.",
    needs: "search",
  },
];

export const DEFAULT_MAX_STEPS = 12;
export const MIN_MAX_STEPS = 1;
export const MAX_MAX_STEPS = 40;

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

/** The tool names stored on an agent (a JSON array). Never throws. */
export function parseToolNames(raw: string | null | undefined): ToolName[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isToolName))];
  } catch {
    return [];
  }
}
