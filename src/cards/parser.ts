import { isBlank, splitLines, type Line } from './lines';
import { classifyLines, type ExclusionKind } from './regions';

export const CARD_ID_PREFIX = 'kioku-';
export const EDIT_RECORD_PREFIX = '%%kioku-edit:';

const QUESTION = /^(?:[-*+][ \t]+)?(?:Q|Ｑ|問)[ \t]*[:：][ \t]*(.*)$/u;
const ANSWER = /^(?:[-*+][ \t]+)?(?:A|Ａ|答)[ \t]*[:：][ \t]*(.*)$/u;
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
const TRAILING_BLOCK_ID = /(^|[ \t]+)\^([A-Za-z0-9-]+)[ \t]*$/;
const EDIT_HEADER = /^%%kioku-edit:([A-Za-z0-9-]+)[ \t]*$/;

export interface CardText {
  readonly question: string;
  readonly answer: string;
}

/** A Q/A block found in ordinary (non-excluded) note text. */
export interface RawBlock extends CardText {
  /** Offset of the first character of the question line. */
  readonly start: number;
  /** Offset after the last content character of the block (before its line break). */
  readonly end: number;
  /** 0-based line index of the question line. */
  readonly line: number;
  /** Block text without a trailing block ID; equals `text.slice(start, end)` when no ID exists. */
  readonly sourceText: string;
  /** Trailing Obsidian block ID of the last line, without `^`. */
  readonly blockId: string | null;
}

export type CandidateStatus = 'new' | 'adopted' | 'duplicate-id' | 'foreign-block-id';

export interface Candidate extends RawBlock {
  readonly status: CandidateStatus;
  /** Kioku card ID (`kioku-…`) when the block was adopted. */
  readonly cardId: string | null;
  /** Edited Q/A recorded for this card in a `%%kioku-edit:<id>` comment. */
  readonly edit: CardText | null;
  /** A new candidate whose content equals an adopted card's effective content. */
  readonly sameAsAdopted: boolean;
}

export interface Range {
  readonly from: number;
  readonly to: number;
}

const fieldText = (parts: readonly string[]): string => parts.join('\n').trim();

/**
 * Finds Q/A blocks in lines whose exclusion kind is null. Deterministic and line based:
 * see docs/architecture.md "明示 Q/A の構文".
 */
export function findBlocks(lines: readonly Line[], kinds: readonly ExclusionKind[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const first = lines[index];
    if (!first || kinds[index] !== null || !QUESTION.test(first.text)) {
      index += 1;
      continue;
    }
    let next = index + 1;
    let answerLine = -1;
    for (; next < lines.length; next += 1) {
      const text = lines[next]?.text ?? '';
      if (kinds[next] !== null || isBlank(text) || HEADING.test(text) || RULE.test(text) || QUESTION.test(text)) break;
      if (ANSWER.test(text)) {
        if (answerLine >= 0) break;
        answerLine = next;
      }
    }
    const block = answerLine < 0 ? null : readBlock(lines, index, answerLine, next - 1);
    if (block) blocks.push(block);
    index = next;
  }
  return blocks;
}

function readBlock(lines: readonly Line[], first: number, answerLine: number, last: number): RawBlock | null {
  const firstLine = lines[first];
  const lastLine = lines[last];
  if (!firstLine || !lastLine) return null;
  const idMatch = lastLine.text.match(TRAILING_BLOCK_ID);
  const blockId = idMatch?.[2] ?? null;
  const lastText = idMatch ? lastLine.text.slice(0, idMatch.index) : lastLine.text;
  const question: string[] = [];
  const answer: string[] = [];
  for (let index = first; index <= last; index += 1) {
    const text = index === last ? lastText : lines[index]?.text ?? '';
    if (index === first) question.push((text.match(QUESTION)?.[1] ?? '').trimEnd());
    else if (index === answerLine) answer.push((text.match(ANSWER)?.[1] ?? '').trimEnd());
    else (index < answerLine ? question : answer).push(text.trimEnd());
  }
  const card = { question: fieldText(question), answer: fieldText(answer) };
  if (!card.question || !card.answer) return null;
  const sourceText = lines.slice(first, last).map((line) => line.text + line.eol).join('') + lastText;
  return { ...card, start: firstLine.start, end: lastLine.end, line: first, blockId, sourceText };
}

/** Reads `%%kioku-edit:<id>` records. Only comment lines can hold a record. */
export function findEditRecords(lines: readonly Line[], kinds: readonly ExclusionKind[]): Map<string, CardText> {
  const records = new Map<string, CardText>();
  for (let index = 0; index < lines.length; index += 1) {
    const id = kinds[index] === 'comment' ? lines[index]?.text.match(EDIT_HEADER)?.[1] : undefined;
    if (!id) continue;
    let close = index + 1;
    while (close < lines.length && lines[close]?.text.trim() !== '%%') close += 1;
    const body = lines.slice(index + 1, close);
    const parsed = findBlocks(body, body.map(() => null));
    const card = parsed[0];
    if (parsed.length === 1 && card && !records.has(id)) records.set(id, { question: card.question, answer: card.answer });
    index = close;
  }
  return records;
}

const normalized = (card: CardText): string => `${card.question.replace(/\s+/gu, ' ')}\u0000${card.answer.replace(/\s+/gu, ' ')}`;

/**
 * Extracts candidates from the whole note, then keeps only blocks overlapping `range`
 * (a non-empty editor selection). Adoption state and duplicates are always judged against
 * the whole note.
 */
export function extractCandidates(text: string, range?: Range): Candidate[] {
  const lines = splitLines(text);
  const kinds = classifyLines(lines);
  const blocks = findBlocks(lines, kinds);
  const edits = findEditRecords(lines, kinds);
  const idCounts = new Map<string, number>();
  for (const block of blocks) {
    if (block.blockId?.startsWith(CARD_ID_PREFIX)) idCounts.set(block.blockId, (idCounts.get(block.blockId) ?? 0) + 1);
  }
  const candidates = blocks.map((block): Candidate => {
    const cardId = block.blockId?.startsWith(CARD_ID_PREFIX) ? block.blockId : null;
    let status: CandidateStatus = 'new';
    if (cardId) status = (idCounts.get(cardId) ?? 0) > 1 ? 'duplicate-id' : 'adopted';
    else if (block.blockId) status = 'foreign-block-id';
    return { ...block, status, cardId, edit: cardId ? edits.get(cardId) ?? null : null, sameAsAdopted: false };
  });
  const adopted = new Set(candidates.filter((item) => item.status === 'adopted')
    .map((item) => normalized(item.edit ?? item)));
  const marked = candidates.map((item) => (item.status === 'new' && adopted.has(normalized(item))
    ? { ...item, sameAsAdopted: true } : item));
  if (!range || range.from === range.to) return marked;
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  return marked.filter((item) => item.start < to && item.end > from);
}

/** Every Kioku ID present in the note (block IDs and edit records), to avoid collisions. */
export function existingCardIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:\^|%%kioku-edit:)(kioku-[A-Za-z0-9-]+)/g)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}
