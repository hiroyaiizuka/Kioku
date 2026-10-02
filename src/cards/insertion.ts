// Inserting a generated card after the block its quote came from (docs/m3-design.md §9, Q2).
// Pure planning, like `planAdoption`: the writer applies the plan through the same safe paths.
import { normalizeField, serializeCard, validateEdit, type AdoptionPlan } from './adoption';
import { generateCardId, type RandomBytes } from './card-id';
import { detectEol, isBlank, splitLines } from './lines';
import { SOURCE_RECORD_PREFIX, existingCardIds, type CardText } from './parser';
import { REASONS } from './reasons';
import { classifyLines } from './regions';

/** A run of ordinary text the card is inserted after: a paragraph, or a whole list / table / quote. */
export interface Anchor {
  /** Offset of the first character of the first line. */
  readonly start: number;
  /** Offset after the last content character (before its line break). */
  readonly end: number;
  /** `text.slice(start, end)`, used to find the block again at adoption time. */
  readonly text: string;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
const INDENTED = /^[ \t]+\S/;

/**
 * Every anchor of the note. A block is a maximal run of non-blank, non-excluded lines (so a table,
 * a `>` quote or callout and a tight list are one block). A loose list (items separated by blank
 * lines) continues across blank lines while the next run starts with a list item or an indented
 * line, so a card is never inserted between two items of one list.
 */
export function findAnchors(text: string): Anchor[] {
  const lines = splitLines(text);
  const kinds = classifyLines(lines);
  const ordinary = (index: number): boolean => kinds[index] === null && !isBlank(lines[index]?.text ?? '');
  const runs: Array<{ first: number; last: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!ordinary(index)) continue;
    const first = index;
    while (index + 1 < lines.length && ordinary(index + 1)) index += 1;
    runs.push({ first, last: index });
  }
  const merged: Array<{ first: number; last: number }> = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    const gapIsBlank = previous !== undefined && lines.slice(previous.last + 1, run.first)
      .every((line, offset) => kinds[previous.last + 1 + offset] === null && isBlank(line.text));
    const previousIsList = previous !== undefined
      && lines.slice(previous.first, previous.last + 1).some((line) => LIST_ITEM.test(line.text));
    const firstText = lines[run.first]?.text ?? '';
    if (previous && gapIsBlank && previousIsList && (LIST_ITEM.test(firstText) || INDENTED.test(firstText))) {
      previous.last = run.last;
    } else {
      merged.push({ ...run });
    }
  }
  return merged.map(({ first, last }) => {
    const start = lines[first]?.start ?? 0;
    const end = lines[last]?.end ?? start;
    return { start, end, text: text.slice(start, end) };
  });
}

/** The anchor containing `offset`, or null when it lies outside ordinary text. */
export function anchorAt(anchors: readonly Anchor[], offset: number): Anchor | null {
  return anchors.find((anchor) => anchor.start <= offset && offset < anchor.end) ?? null;
}

/**
 * Why a quote cannot be stored in a `%%kioku-src` record, or null. The same rules as edit records:
 * `%%` would flip the comment parity and expose or hide later text; the others keep the record inert.
 */
export function validateQuoteRecord(quote: string): string | null {
  const lines = quote.split(/\r\n|\r|\n/);
  if (!quote.trim() || lines.some((line) => isBlank(line))) return REASONS.quoteRecord;
  if (quote.includes('%%') || quote.includes('$$') || quote.includes('<!--') || quote.includes('-->')) return REASONS.quoteRecord;
  if (/\^kioku-/.test(quote)) return REASONS.quoteRecord;
  const marker = /^\s*(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|(?:[-*+][ \t]+)?(?:Q|Ｑ|問|A|Ａ|答)[ \t]*[:：])/u;
  if (lines.some((line) => marker.test(line))) return REASONS.quoteRecord;
  return null;
}

/** What the popup remembers about a generated candidate between generation and the adopt click. */
export interface RecordedAnchor {
  readonly start: number;
  readonly text: string;
  /** The quote exactly as found in the note (not normalized). */
  readonly quote: string;
}

function locate(text: string, recorded: RecordedAnchor): Anchor | string {
  const matches = findAnchors(text).filter((anchor) => anchor.text === recorded.text);
  const target = matches.find((anchor) => anchor.start === recorded.start) ?? (matches.length === 1 ? matches[0] : undefined);
  if (target) return target;
  return matches.length > 1 ? REASONS.ambiguous : REASONS.sourceChanged;
}

/**
 * Re-verifies the recorded block against `text` (the current editor or file content) and plans
 * one insertion after it: a blank line, the Q/A block ending in ` ^kioku-<id>`, a blank line and
 * the quote record; plus one more line break when non-blank text follows directly. The note's
 * existing characters never change. Never guesses: any mismatch returns `ok: false`.
 */
export function planInsertion(text: string, recorded: RecordedAnchor, edited: CardText, random?: RandomBytes): AdoptionPlan {
  const card = { question: normalizeField(edited.question), answer: normalizeField(edited.answer) };
  const invalid = validateEdit(card) ?? validateQuoteRecord(recorded.quote);
  if (invalid) return { ok: false, reason: invalid };
  const target = locate(text, recorded);
  if (typeof target === 'string') return { ok: false, reason: target };
  const after = text.slice(target.end);
  const eol = after.match(/^(?:\r\n|\r|\n)/)?.[0] ?? detectEol(text);
  const cardId = generateCardId(existingCardIds(text), random);
  const quote = recorded.quote.split(/\r\n|\r|\n/).map((line) => line.trimEnd()).join(eol);
  let insert = `${eol}${eol}${serializeCard(card, eol)} ^${cardId}${eol}${eol}${SOURCE_RECORD_PREFIX}${cardId}${eol}${quote}${eol}%%`;
  const nextLine = after.slice(eol.length).split(/\r\n|\r|\n/)[0] ?? '';
  if (after.length > 0 && !isBlank(nextLine)) insert += eol;
  const offset = target.end;
  return { ok: true, cardId, offset, insert, next: text.slice(0, offset) + insert + text.slice(offset) };
}
