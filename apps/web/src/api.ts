/**
 * The web app's only network layer: a typed JSON-RPC client over the amritad
 * HTTP surface (`POST /rpc`, `GET /events`). No secret ever appears in a request
 * or a rendered response (the daemon guarantees secret-free results).
 */

export type FetchLike = typeof fetch;

export class RpcError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
  }
}

export interface AmritaEventLite {
  id: string;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface RpcClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Local control-surface bearer token (never logged; sent as Authorization). */
  token?: string;
}

export class RpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private authToken: string | undefined;
  private nextId = 1;

  constructor(opts: RpcClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.authToken = opts.token || undefined;
  }

  /** Set/clear the bearer token used for subsequent calls (never logged). */
  setAuthToken(token: string | undefined): void {
    this.authToken = token || undefined;
  }

  hasAuthToken(): boolean {
    return this.authToken !== undefined;
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { authorization: `Bearer ${this.authToken}` } : {};
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ id: this.nextId++, method, params }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new RpcError('unauthorized', 'authentication required');
    }
    const body = (await res.json()) as RpcEnvelope;
    if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.details);
    return body.result as T;
  }

  async events(conversationId: string, sinceSeq = 0): Promise<AmritaEventLite[]> {
    const url = `${this.baseUrl}/events?conversationId=${encodeURIComponent(conversationId)}&sinceSeq=${sinceSeq}`;
    const res = await this.fetchImpl(url, { headers: this.authHeaders() });
    if (res.status === 401 || res.status === 403) {
      throw new RpcError('unauthorized', 'authentication required');
    }
    const body = (await res.json()) as { events?: AmritaEventLite[] };
    return body.events ?? [];
  }
}
