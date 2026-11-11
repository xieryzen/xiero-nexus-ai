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
