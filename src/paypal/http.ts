export type HttpResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export type HttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export function createFetchClient(fetchImpl: typeof fetch = fetch): HttpClient {
  return async (req) => {
    const response = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, body: await response.text(), headers };
  };
}

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | null,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** PayPal error name, issue, and debug_id. Does not include the request body. */
export function formatPayPalError(method: string, path: string, status: number, body: unknown): {
  message: string;
  debugId: string | null;
} {
  const record = isRecord(body) ? body : {};
  const name = typeof record.name === "string" ? record.name : "";
  const debugId = typeof record.debug_id === "string" ? record.debug_id : null;
  const details = Array.isArray(record.details) ? record.details : [];
  const issues = details
    .map((detail) => (isRecord(detail) && typeof detail.issue === "string" ? detail.issue : ""))
    .filter(Boolean)
    .join(", ");
  const message = `PayPal ${method} ${path} failed (${status}${name ? ` ${name}` : ""}${issues ? `: ${issues}` : ""}${debugId ? `; debug_id=${debugId}` : ""})`;
  console.error(message);
  return { message, debugId };
}

export function parseJson(body: string): unknown {
  if (!body) return null;
  return JSON.parse(body) as unknown;
}
