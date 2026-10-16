// Provider HTTP: an injected fetch, a 10 s timeout, bounded retries on 429 and
// 5xx that honor Retry-After, and errors that never carry bodies, headers or
// tokens.

export type Fetch = typeof globalThis.fetch;

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    what: string
  ) {
    super(`${what} failed with HTTP ${status}.`);
  }
}

export type HttpOptions = {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  timeoutMs?: number;
};

export async function send(
  options: HttpOptions,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    });
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < retries
    ) {
      const after = Number(response.headers.get("retry-after"));
      await sleep(
        Math.min(
          Number.isFinite(after) && after > 0
            ? after * 1000
            : 500 * 2 ** attempt,
          5_000
        )
      );
      continue;
    }
    return response;
  }
}

/** The JSON body of a successful response, or a ProviderHttpError. */
export async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new ProviderHttpError(response.status, what);
  return (await response.json()) as T;
}

/** The URL of a `Link: <…>; rel="next"` header, if any. */
export function nextLink(response: Response) {
  const link = response.headers.get("link") ?? "";
  return link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}
