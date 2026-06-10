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
}

export class RpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private nextId = 1;

  constructor(opts: RpcClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.nextId++, method, params }),
    });
    const body = (await res.json()) as RpcEnvelope;
    if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.details);
    return body.result as T;
  }

  async events(conversationId: string, sinceSeq = 0): Promise<AmritaEventLite[]> {
    const url = `${this.baseUrl}/events?conversationId=${encodeURIComponent(conversationId)}&sinceSeq=${sinceSeq}`;
    const res = await this.fetchImpl(url);
    const body = (await res.json()) as { events?: AmritaEventLite[] };
    return body.events ?? [];
  }
}
