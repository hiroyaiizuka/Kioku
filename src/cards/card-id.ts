import { CARD_ID_PREFIX } from './parser';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 10;
/** 252 = 7 * 36: bytes at or above it are rejected so every character is equally likely. */
const UNBIASED_LIMIT = 252;

export type RandomBytes = (length: number) => Uint8Array;

const browserRandom: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/** `length` unbiased random characters from `[0-9a-z]` (rejection sampling). */
export function randomBase36(length: number, random: RandomBytes = browserRandom): string {
  let body = '';
  for (let round = 0; body.length < length; round += 1) {
    if (round >= 16) throw new Error('Kioku random source returned unusable bytes.');
    for (const byte of random(length * 2)) {
      if (byte < UNBIASED_LIMIT && body.length < length) body += ALPHABET[byte % ALPHABET.length];
    }
  }
  return body;
}

/**
 * A random (not content-derived) card ID, so editing the Q/A text later keeps the identity.
 * Re-draws when the note already contains the same ID.
 */
export function generateCardId(existing: ReadonlySet<string>, random: RandomBytes = browserRandom): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `${CARD_ID_PREFIX}${randomBase36(ID_LENGTH, random)}`;
    if (!existing.has(id)) return id;
  }
  throw new Error('Kioku could not generate a unique card ID.');
}

export const CARD_ID_PATTERN = /^kioku-[0-9a-z]{10}$/;
