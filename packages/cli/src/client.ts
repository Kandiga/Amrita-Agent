import { type AmritaKernel, dispatch, isErrorResponse } from '@amrita/daemon';

/** An RPC call failed at the daemon (structured, secret-free). */
export class RpcClientError extends Error {
  readonly rpcCode: string;
  readonly details: unknown;
  constructor(rpcCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RpcClientError';
    this.rpcCode = rpcCode;
    this.details = details;
  }
}

/** A CLI-side usage/resolution error (bad args, missing project, …). */
export class CliError extends Error {
  readonly code: string;
  constructor(message: string, code = 'cli_error') {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/**
 * Speaks to the amritad RPC layer **in process** (no subprocess): it dispatches
 * directly against a kernel opened on the given DB. Fast and deterministic for a
 * CLI and for tests. Errors become exceptions; results are returned raw.
 */
export class InProcessClient {
  private readonly kernel: AmritaKernel;
  constructor(kernel: AmritaKernel) {
    this.kernel = kernel;
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const r = await dispatch(this.kernel, { id: null, method, params });
    if (isErrorResponse(r)) {
      throw new RpcClientError(r.error.code, r.error.message, r.error.details);
    }
    return r.result as T;
  }
}
