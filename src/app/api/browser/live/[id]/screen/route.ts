import { handle } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { livePicture } from "@/lib/browser/sessions";
import { AppError, Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** A picture of the page as it is now. The address of the page is in the header "x-page-url". */
export const GET = handle(async (_req, { params }) => {
  const user = requireAdmin();
  const rate = rateLimit(`browser-screen:${user.id}`, 240, 60_000);
  if (!rate.ok) throw Errors.rateLimited("Too many pictures were asked for. The page is shown again in a moment.");
  const shot = await livePicture(params.id!, user);
  if (!shot) throw Errors.notFound("This page does not wait any more: it was handed back, or its time was up.");
  // Between two pages there is no picture to take: the next one is asked for in a moment.
  if (shot === "later") throw new AppError(503, "not_now", "The page is changing. The next picture shows it.");
  return new Response(new Uint8Array(shot.jpeg), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      "x-page-url": encodeURI(shot.url).slice(0, 1000),
    },
  });
});
