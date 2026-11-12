"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** JSON fetch helper for client components. Throws ApiError on non-2xx. */
export async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } })?.error;
    throw new ApiError(err?.message ?? "Request failed", err?.code ?? "error", res.status);
  }
  return data as T;
}

/**
 * Copy text to the clipboard. Resolves to whether it worked.
 *
 * `navigator.clipboard` exists only on HTTPS and on localhost, and this app
 * is also run over plain HTTP on a private network (`COOKIE_SECURE=false`),
 * so the older selection-based copy is the fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not allowed here: try the fallback.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus();
  }
}
