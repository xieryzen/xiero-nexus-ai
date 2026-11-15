"use client";

import { useEffect, useRef } from "react";
import type { MediaAssetDTO } from "@/lib/media/dto";
import { apiFetch, ApiError } from "@/lib/client";

export interface MediaPollHandlers {
  /** The asset as the server has it now (still pending, ready or failed). */
  onUpdate: (asset: MediaAssetDTO, checkError: string | null) => void;
  /** The asset no longer exists, or is no longer this user's to see. */
  onGone?: (assetId: string) => void;
}

/**
 * While any of `pendingIds` is given, ask the server every few seconds how
 * those videos are doing. The server's background worker moves them forward
 * by itself; asking also makes it check a provider's video at once, so the
 * page shows the result as soon as it is there.
 * One request at a time, so a slow download does not pile requests up.
 */
export function useMediaPolling(
  pendingIds: string[],
  handlers: MediaPollHandlers,
  intervalMs = 5000,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const key = [...pendingIds].sort().join(",");

  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    let stopped = false;
    let busy = false;

    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        for (const id of ids) {
          if (stopped) break;
          try {
            const res = await apiFetch<{ asset: MediaAssetDTO; checkError: string | null }>(
              `/api/media/${id}/refresh`,
              { method: "POST" },
            );
            if (!stopped) latest.current.onUpdate(res.asset, res.checkError);
          } catch (err) {
            if (!stopped && err instanceof ApiError && (err.status === 404 || err.status === 403)) {
              latest.current.onGone?.(id);
            }
            // Anything else (offline, a restart): try again on the next tick.
          }
        }
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, intervalMs]);
}
