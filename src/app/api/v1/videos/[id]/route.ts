import { NextResponse } from "next/server";
import { Errors } from "@/lib/errors";
import { loadOwnedAsset, refreshVideo } from "@/lib/media/service";
import { mediaJson, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A video's state. Asking also moves a video in progress forward. */
export const GET = v1("media", async (_req, { params, caller }) => {
  const owned = loadOwnedAsset(params.id!, caller.user);
  if (owned.kind !== "video") throw Errors.notFound("Video not found");
  const { asset, checkError } = await refreshVideo(owned.id);
  // `check_error`: why the provider could not be asked this time. The video is
  // then unchanged, and the next request asks again.
  return NextResponse.json({ ...mediaJson(asset), check_error: checkError ?? null });
});
