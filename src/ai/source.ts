// The text Kioku sends to a generator, and mapping quotes back to the note (docs/m3-design.md §4, §6.1).
import { anchorAt, findAnchors, type Anchor } from '../cards/insertion';
import { splitLines } from '../cards/lines';
import type { Range } from '../cards/parser';
import { classifyLines } from '../cards/regions';

/** The sent text and, for each of its UTF-16 units, the note offset it came from (-1 = inserted by Kioku). */
export interface SourceText {
  readonly text: string;
  readonly origin: readonly number[];
}

/** Maximum characters sent per run (E2 initial value). */
export const MAX_SOURCE_CHARS = 8000;

const EXCALIDRAW_KEY = /^excalidraw-plugin\s*:/;

/** Excalidraw notes are never sent (inserting near drawing data could break it, §9 item 5). */
export function isExcalidrawNote(note: string): boolean {
  const lines = splitLines(note);
  const kinds = classifyLines(lines);
  return kinds.some((kind) => kind === 'excalidraw')
    || lines.some((line, index) => kinds[index] === 'frontmatter' && EXCALIDRAW_KEY.test(line.text));
}

/** Kept [from, to) intervals of one ordinary line after removing inline `%%…%%` and `<!--…-->`. */
function keptIntervals(text: string): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  let position = 0;
  while (position < text.length) {
    const percent = text.indexOf('%%', position);
    const html = text.indexOf('<!--', position);
    const opener = percent < 0 ? html : html < 0 ? percent : Math.min(percent, html);
    if (opener < 0) break;
    const isPercent = opener === percent;
    const close = isPercent ? text.indexOf('%%', opener + 2) : text.indexOf('-->', opener + 4);
    if (close < 0) break;
    if (opener > position) kept.push([position, opener]);
    position = close + (isPercent ? 2 : 3);
  }
  if (position < text.length) kept.push([position, text.length]);
  return kept;
}

/**
 * Builds the text to send from the whole note or the selected range: frontmatter, code fences,
 * `%%` / HTML comment blocks and `$$` math blocks are dropped by line (M1 `classifyLines`), and
 * inline `%%…%%` / `<!--…-->` are removed from the remaining lines. The note title is never part
 * of it (Q7). A gap left by removed lines becomes a blank line so the model sees a block boundary.
 */
export function buildSource(note: string, range?: Range): SourceText {
  const lines = splitLines(note);
  const kinds = classifyLines(lines);
  const from = range && range.from !== range.to ? Math.min(range.from, range.to) : 0;
  const to = range && range.from !== range.to ? Math.max(range.from, range.to) : note.length;
  let text = '';
  const origin: number[] = [];
  let previous = -1;
  let gap = false;
  const push = (chunk: string, at: number): void => {
    for (let index = 0; index < chunk.length; index += 1) origin.push(at < 0 ? -1 : at + index);
    text += chunk;
  };
  lines.forEach((line, index) => {
    if (kinds[index] !== null || line.end < from || line.start >= to) {
      if (previous >= 0) gap = true;
      return;
    }
    const pieces = keptIntervals(line.text)
      .map(([start, end]): [number, number] => [Math.max(line.start + start, from), Math.min(line.start + end, to)])
      .filter(([start, end]) => end > start);
    if (previous >= 0) {
      if (gap || previous !== index - 1) push('\n\n', -1);
      else push('\n', lines[previous]?.end ?? -1);
    }
    pieces.forEach(([start, end], position) => {
      if (position > 0) push(' ', -1);
      push(note.slice(start, end), start);
    });
    previous = index;
    gap = false;
  });
  return { text, origin };
}

/** NFC, every whitespace run as one space, trimmed (full/half width and punctuation unchanged). */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Normalized text with, per UTF-16 unit, the [start, end) range of source units it came from. */
function normalizeWithMap(source: string): { text: string; spans: Array<[number, number]> } {
  let text = '';
  const spans: Array<[number, number]> = [];
  let space = false;
  for (const match of source.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (/^\s+$/u.test(match[0])) {
      if (!space) {
        text += ' ';
        spans.push([start, end]);
      } else {
        const last = spans[spans.length - 1];
        if (last) last[1] = end;
      }
      space = true;
      continue;
    }
    space = false;
    const normal = match[0].normalize('NFC');
    text += normal;
    for (let index = 0; index < normal.length; index += 1) spans.push([start, end]);
  }
  return { text, spans };
}

export interface LocatedQuote {
  /** Note offsets of the quote (exactly as written in the note). */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Offsets in the sent text, for the judge's context window. */
  readonly sentStart: number;
  readonly sentEnd: number;
  /** The block the card will be inserted after. */
  readonly anchor: Anchor;
  /** The same sentence also appears in another block (the card goes after the first). */
  readonly elsewhere: boolean;
}

const BLANK_LINE = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r|\n)/;

/**
 * Finds `quote` in the sent text and maps it back to the note. A match counts only if it maps to
 * one contiguous stretch of ordinary note text (not across removed comments or excluded lines) that
 * normalizes to the same text, inside one block (no blank line). Returns null when no match counts.
 */
export function locateQuote(note: string, source: SourceText, quote: string): LocatedQuote | null {
  const wanted = normalizeForMatch(quote);
  if (!wanted) return null;
  const normal = normalizeWithMap(source.text);
  const anchors = findAnchors(note);
  const found: Array<Omit<LocatedQuote, 'elsewhere'>> = [];
  for (let at = normal.text.indexOf(wanted); at >= 0; at = normal.text.indexOf(wanted, at + 1)) {
    const first = normal.spans[at];
    const last = normal.spans[at + wanted.length - 1];
    if (!first || !last) continue;
    const sentStart = first[0];
    const sentEnd = last[1];
    const origins = source.origin.slice(sentStart, sentEnd);
    if (origins.some((offset) => offset < 0)) continue;
    const start = origins[0] ?? -1;
    const end = (origins[origins.length - 1] ?? -1) + 1;
    const text = note.slice(start, end);
    if (normalizeForMatch(text) !== wanted || BLANK_LINE.test(text)) continue;
    const anchor = anchorAt(anchors, start);
    if (!anchor || end > anchor.end) continue;
    found.push({ start, end, text, sentStart, sentEnd, anchor });
  }
  const firstMatch = found[0];
  if (!firstMatch) return null;
  return { ...firstMatch, elsewhere: found.some((item) => item.anchor.start !== firstMatch.anchor.start) };
}
