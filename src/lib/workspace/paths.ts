import { AppError } from "../errors";

/**
 * Validate a workspace-relative file path. Pure + testable.
 * Blocks absolute paths, traversal (`..`), backslashes, control chars, and
 * unusual characters. Returns a normalized relative path.
 */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/;

export function validateWorkspacePath(input: string): string {
  const path = input.trim();
  if (!path) throw new AppError(400, "invalid_path", "File path is required");
  if (path.length > 256) throw new AppError(400, "invalid_path", "File path is too long");
  if (path.includes("\\")) throw new AppError(400, "invalid_path", "Backslashes are not allowed");
  if (path.startsWith("/")) throw new AppError(400, "invalid_path", "Path must be relative");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) throw new AppError(400, "invalid_path", "Control characters are not allowed");
  if (!SAFE.test(path)) throw new AppError(400, "invalid_path", "Path contains invalid characters");

  const segments = path.split("/");
  if (segments.length > 20) throw new AppError(400, "invalid_path", "Path is too deep");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new AppError(400, "invalid_path", "Path may not contain empty or relative segments");
    }
    if (seg.length > 100) throw new AppError(400, "invalid_path", "A path segment is too long");
  }
  return segments.join("/");
}
