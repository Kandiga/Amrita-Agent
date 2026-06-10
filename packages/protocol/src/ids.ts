import { ulid } from 'ulid';
import { z } from 'zod';

/**
 * Amrita uses ULIDs for every domain identifier: lexicographically sortable,
 * URL-safe, 26 chars, k-sorted by creation time. Never auto-increment integers
 * in the domain — those belong only to SQLite rowids inside the store.
 */
export function newId(): string {
  return ulid();
}

/** A 26-char Crockford-base32 ULID. */
export const ulidSchema = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a Crockford-base32 ULID');

/** ISO-8601 timestamp string (what we put on the wire and in `ts` columns). */
export const isoTimestampSchema = z.string().datetime({ offset: true });

/** A project/conversation/turn/lane id — a ULID, but named for readability. */
export const idSchema = ulidSchema;
