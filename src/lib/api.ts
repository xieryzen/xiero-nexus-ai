import { NextResponse } from "next/server";
import type { ZodSchema } from "zod";
import { getCurrentUser } from "./auth";
import { AppError, Errors } from "./errors";
import { errorFor } from "./shown";

type RouteCtx = { params: Record<string, string> };
type Handler = (req: Request, ctx: RouteCtx) => Promise<Response> | Response;

/** Convert any thrown value into a safe JSON response. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status },
    );
  }
  // eslint-disable-next-line no-console
  console.error("[xiero-nexus] unhandled error:", err);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong" } },
    { status: 500 },
  );
}

/** The role of whoever sent the request; none when they are not signed in. */
function requesterRole(): string | null {
  try {
    return getCurrentUser()?.role ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap a route handler so thrown AppErrors become safe JSON responses. An
 * error that names a provider or a model is told in full to those who are
 * shown the setup, and to anyone else as "this could not be done just now"
 * (shown.ts).
 */
export function handle(fn: Handler) {
  return async (req: Request, ctx: RouteCtx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      return toErrorResponse(err instanceof AppError ? errorFor(requesterRole(), err) : err);
    }
  };
}

/** Parse + validate a JSON body against a Zod schema, or throw a safe 400. */
export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw Errors.badRequest("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw Errors.badRequest(
      issue ? `${path ? `${path}: ` : ""}${issue.message}` : "Invalid request",
    );
  }
  return parsed.data;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}
