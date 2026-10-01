import { generateCardId, type RandomBytes } from './card-id';
import { detectEol, splitLines } from './lines';
import { EDIT_RECORD_PREFIX, existingCardIds, extractCandidates, findBlocks, type Candidate, type CardText } from './parser';

/** What the modal remembers about a candidate between extraction and the adopt click. */
export interface RecordedCandidate {
  readonly start: number;
  readonly sourceText: string;
}

export type AdoptionPlan =
  | { readonly ok: true; readonly cardId: string; readonly offset: number; readonly insert: string; readonly next: string }
  | { readonly ok: false; readonly reason: string };

/** Trims every line end and the whole field, like the parser does. */
export function normalizeField(value: string): string {
  return value.split(/\r\n|\r|\n/).map((line) => line.trimEnd()).join('\n').trim();
}

function serializeCard(card: CardText, eol: string): string {
  return `Q: ${card.question}\nA: ${card.answer}`.split('\n').map((line) => line.trimEnd()).join(eol);
}

/**
 * Returns a Japanese reason when an edited card cannot be stored losslessly in an edit record.
 * The record must parse back to exactly the same Q/A with Kioku's own parser.
 */
export function validateEdit(card: CardText): string | null {
  if (!card.question) return '問いが空です。';
  if (!card.answer) return '答えが空です。';
  const joined = `${card.question}\n${card.answer}`;
  if (joined.includes('%%')) return '「%%」は編集記録に含められません。';
  if (/\^kioku-/.test(joined)) return '「^kioku-」は編集記録に含められません。';
  if (joined.split('\n').some((line) => /^\s*(?:`{3,}|~{3,})/.test(line))) return 'コードブロックの区切り（``` や ~~~）は編集記録に含められません。';
  if (joined.includes('$$')) return '「$$」は編集記録に含められません。';
  if (joined.includes('<!--') || joined.includes('-->')) return 'HTML コメントは編集記録に含められません。';
  const lines = splitLines(serializeCard(card, '\n'));
  const parsed = findBlocks(lines, lines.map(() => null));
  const only = parsed[0];
  if (parsed.length !== 1 || !only || only.question !== card.question || only.answer !== card.answer) {
    return '空行・見出し・行頭の問い/答えの印（Q: や A: など）を含む編集は保存できません。';
  }
  return null;
}

function sameText(a: CardText, b: CardText): boolean {
  return a.question === b.question && a.answer === b.answer;
}

function locate(candidates: readonly Candidate[], recorded: RecordedCandidate): Candidate | string {
  const matches = candidates.filter((item) => item.sourceText === recorded.sourceText);
  const target = matches.find((item) => item.start === recorded.start)
    ?? (matches.length === 1 ? matches[0] : undefined);
  if (!target) {
    return matches.length > 1
      ? '同じ原文が複数あり、位置を特定できません（外部で変更された可能性があります）。'
      : '原文が抽出後に変更されています。もう一度抽出してください。';
  }
  if (target.status === 'adopted' || target.status === 'duplicate-id') return 'この問い・答えは既に採用済みです。';
  if (target.status === 'foreign-block-id') return '既存の block ID があるため採用できません。';
  return target;
}

/**
 * Re-verifies the recorded original text against `text` (the current editor or file content)
 * and computes the single insertion. Never guesses: any mismatch returns `ok: false`.
 */
export function planAdoption(text: string, recorded: RecordedCandidate, edited: CardText,
  random?: RandomBytes): AdoptionPlan {
  const target = locate(extractCandidates(text), recorded);
  if (typeof target === 'string') return { ok: false, reason: target };
  const edit = { question: normalizeField(edited.question), answer: normalizeField(edited.answer) };
  const changed = !sameText(edit, target);
  if (changed) {
    const invalid = validateEdit(edit);
    if (invalid) return { ok: false, reason: invalid };
  }
  const cardId = generateCardId(existingCardIds(text), random);
  // Match the block's own line break (notes can mix CRLF and LF); at EOF fall back to the note's.
  const eol = text.slice(target.end).match(/^(?:\r\n|\r|\n)/)?.[0] ?? detectEol(text);
  let insert = ` ^${cardId}`;
  if (changed) insert += `${eol}${eol}${EDIT_RECORD_PREFIX}${cardId}${eol}${serializeCard(edit, eol)}${eol}%%`;
  // The block (or its edit record) must end a paragraph so `^kioku-…` is a valid block ID:
  // when non-blank text follows directly, add exactly one line break (a blank line). The tight-list
  // exception applies only without an edit record, which is a separate block needing a blank line.
  if (changed ? target.followedByText : target.needsBlankLine) insert += eol;
  const offset = target.end;
  return { ok: true, cardId, offset, insert, next: text.slice(0, offset) + insert + text.slice(offset) };
}
