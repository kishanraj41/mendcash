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

export function parseJson(body: string): unknown {
  if (!body) return null;
  return JSON.parse(body) as unknown;
}
