import type { AppConfig } from "../config";
import { createFetchClient, parseJson, PayPalApiError, type HttpClient } from "./http";

export type PayPalRestOptions = {
  config: AppConfig;
  http?: HttpClient;
  now?: () => Date;
};

export class PayPalRest {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly http: HttpClient;
  private readonly now: () => Date;

  constructor(private readonly options: PayPalRestOptions) {
    this.http = options.http || createFetchClient();
    this.now = options.now || (() => new Date());
  }

  get baseUrl(): string {
    return this.options.config.paypal.baseUrl;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now().getTime() + 30_000) return this.token.value;
    const { clientId, clientSecret } = this.options.config.paypal;
    if (!clientId || !clientSecret) throw new Error("PayPal credentials are not set.");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await this.http({
      method: "POST",
      url: `${this.baseUrl}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const body = parseJson(response.body) as { access_token?: string; expires_in?: number };
    if (response.status !== 200 || !body?.access_token) {
      throw new PayPalApiError("PayPal auth failed", response.status, debugId(body));
    }
    this.token = {
      value: body.access_token,
      expiresAt: this.now().getTime() + (body.expires_in || 300) * 1000,
    };
    return body.access_token;
  }

  async json(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.http({ method, url: `${this.baseUrl}${path}`, headers, body: payload });
    const parsed = safeParse(response.body);
    if (response.status >= 400) {
      throw new PayPalApiError(`PayPal ${method} ${path} failed (${response.status})`, response.status, debugId(parsed));
    }
    return parsed;
  }

  async multipart(path: string, jsonBody: unknown, requestId: string): Promise<unknown> {
    const token = await this.accessToken();
    const { contentType, body } = encodeMultipart(JSON.stringify(jsonBody));
    const response = await this.http({
      method: "POST",
      url: `${this.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": contentType,
        "PayPal-Request-Id": requestId,
      },
      body,
    });
    const parsed = safeParse(response.body);
    if (response.status >= 400) {
      throw new PayPalApiError(`PayPal POST ${path} failed (${response.status})`, response.status, debugId(parsed));
    }
    return parsed;
  }
}

function safeParse(body: string): unknown {
  try {
    return parseJson(body);
  } catch {
    return { raw: body.slice(0, 200) };
  }
}

function debugId(body: unknown): string | null {
  if (body && typeof body === "object" && "debug_id" in body) {
    const id = (body as { debug_id?: unknown }).debug_id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export function encodeMultipart(json: string): { contentType: string; body: string } {
  const boundary = "----mendcashform7";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="input"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${json}\r\n` +
    `--${boundary}--\r\n`;
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}
