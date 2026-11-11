import { AppError } from "../errors";

/**
 * Command allowlisting for sandbox execution. Pure + testable.
 * The command is treated as argv (no shell): shell metacharacters are rejected
 * so chaining/piping/substitution can't smuggle extra commands, and the first
 * token must be an allowed binary. The sandbox container is the real boundary;
 * this is defense in depth.
 */

export const DEFAULT_ALLOWED_COMMANDS = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "pytest",
  "pip",
  "pip3",
  "tsc",
  "jest",
  "vitest",
  "eslint",
  "prettier",
  "go",
  "cargo",
  "make",
  "ls",
  "cat",
  "echo",
  "true",
];

// Characters that would enable shell chaining/redirection/substitution.
const SHELL_META = /[;&|<>`$(){}!#\n\r*?~]/;

export interface ParsedCommand {
  argv: string[];
}

export function parseCommand(command: string, allowed: string[]): ParsedCommand {
  const trimmed = command.trim();
  if (!trimmed) throw new AppError(400, "invalid_command", "A command is required");
  if (trimmed.length > 2000) throw new AppError(400, "invalid_command", "Command is too long");
  if (SHELL_META.test(trimmed)) {
    throw new AppError(
      400,
      "invalid_command",
      "Shell metacharacters are not allowed. Run a single program (e.g. `npm test`).",
    );
  }
  const argv = trimmed.split(/\s+/);
  const bin = argv[0]!;
  if (!allowed.includes(bin)) {
    throw new AppError(400, "command_not_allowed", `"${bin}" is not in the allowed command list`);
  }
  return { argv };
}
