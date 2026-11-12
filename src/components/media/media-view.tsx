"use client";

import { useEffect, useState } from "react";
import type { MediaAssetDTO } from "@/lib/media/dto";
import { Icon } from "@/components/icons";
import { Spinner, cn } from "@/components/ui";

function elapsedLabel(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Counts up while a video is being generated. */
function Elapsed({ since }: { since: number }) {
  // Starts empty, so the server-rendered page and the browser agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{now === null ? "" : elapsedLabel(since, now)}</>;
}

/**
 * The preview of one asset: the image, the video player, a "generating" box
 * while a video is in progress, or a "failed" box. The box has a fixed height
 * and the media is fitted inside it, whatever its shape, so a list of
 * previews does not move when files arrive.
 */
export function MediaView({
  asset,
  heightClass = "h-64",
  className,
}: {
  asset: MediaAssetDTO;
  /** Tailwind height class of the box. */
  heightClass?: string;
  className?: string;
}) {
  const box = cn(
    "relative w-full overflow-hidden rounded-md border border-line bg-black/40",
    heightClass,
    className,
  );

  if (asset.status === "ready" && asset.url) {
    if (asset.kind === "image") {
      return (
        <a href={asset.url} target="_blank" rel="noreferrer" className={cn(box, "block")} title="Open the full image">
          {/* A private, authenticated file that already has the size it was
              generated at: next/image has nothing to optimise here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.url}
            alt={asset.prompt.slice(0, 200)}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain"
          />
        </a>
      );
    }
    return (
      <div className={box}>
        {/* "#t=0.1" makes browsers that show no frame before playback show one. */}
        <video
          src={`${asset.url}#t=0.1`}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
        />
      </div>
    );
  }

  if (asset.status === "pending") {
    return (
      <div className={cn(box, "grid place-items-center")} role="status">
        <div className="flex flex-col items-center gap-2 px-4 text-center text-ink-2">
          <Spinner size={20} />
          <p className="text-sm">Generating the video…</p>
          <p className="text-xs text-ink-3">
            <Elapsed since={asset.createdAt} /> so far. This can take a few minutes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(box, "grid place-items-center")}>
      <div className="flex flex-col items-center gap-2 px-4 text-center text-danger">
        <Icon name="warning" size={20} />
        <p className="text-sm">{asset.status === "failed" ? "Generation failed" : "The file is not available"}</p>
      </div>
    </div>
  );
}
