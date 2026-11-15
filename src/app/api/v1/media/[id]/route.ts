import { NextResponse } from "next/server";
import { loadOwnedAsset } from "@/lib/media/service";
import { mediaJson, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/** An image, a voice-over or a video of the user's library. */
export const GET = v1("media", (_req, { params, caller }) =>
  NextResponse.json(mediaJson(loadOwnedAsset(params.id!, caller.user))),
);
