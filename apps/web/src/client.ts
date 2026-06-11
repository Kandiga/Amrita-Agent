import { RpcClient } from './api.ts';

/**
 * The app-wide RPC client singleton. One instance so the bearer token set by
 * the auth panel applies to every caller (App shell and extracted components
 * alike). The token lives only inside this instance — never in component
 * state, props, or storage beyond src/auth.ts's localStorage handling.
 */
export const client = new RpcClient();
