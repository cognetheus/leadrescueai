import { randomBytes } from 'node:crypto';

/**
 * Prefixed, time-sortable identifiers (48-bit millisecond timestamp + 80 random bits).
 * The prefix makes IDs self-describing in logs, traces and support tickets.
 */
export type IdPrefix =
  | 'ten' | 'evt' | 'dlv' | 'att' | 'job' | 'inc' | 'ine' | 'aud' | 'cred'
  | 'rec' | 'rcf' | 'asm' | 'scn' | 'cor' | 'lease' | 'met';

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  const time = now.toString(16).padStart(12, '0');
  return `${prefix}_${time}${randomBytes(10).toString('hex')}`;
}
