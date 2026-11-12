import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";
import { runProject, type RunEvent } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";
// A hint for serverless hosts only. The self-hosted server (`next start`, the
// release bundle) does not enforce it, and a run that generates videos can
// take much longer: it waits up to 15 minutes for each video.
export const maxDuration = 300;

export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user); // throws if not owner/admin

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: RunEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      try {
        await runProject(project.id, emit);
      } catch {
        emit({ type: "error", message: "Run failed unexpectedly" });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
