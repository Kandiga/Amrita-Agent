/**
 * Strip `undefined`-valued keys from an object. The result type drops
 * `| undefined` from each (still-optional) property, so a value deserialized from
 * JSON-RPC — where zod's `.optional()` yields `T | undefined` — becomes assignable
 * to the store's exact-optional inputs (`exactOptionalPropertyTypes`). At runtime
 * an absent optional stays absent; only explicit `undefined` is removed.
 */
export function clean<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
