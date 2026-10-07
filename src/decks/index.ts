// Deck membership, the listed decks and duplicate IDs. Pure; see docs/m2-design.md §3.
import type { ReviewCard } from '../review/queue';
import type { CardId } from '../review/types';
import { tagKey } from './tags';

/** What the scan found in one note. */
export interface NoteCards {
  readonly path: string;
  /** Trigger-matching tags of the note (whole-note scope), without `#`. */
  readonly deckTags: readonly string[];
  /** Adopted cards in note order, with their effective (possibly edited) Q/A. */
  readonly cards: readonly { readonly id: CardId; readonly question: string; readonly answer: string }[];
}

export interface DeckNode {
  /** Lower-cased tag path, e.g. `kioku/医学`. */
  readonly key: string;
  /** Full tag path as first spelled, e.g. `kioku/医学`. */
  readonly label: string;
  /** Cards of this deck and all of its descendants, unique by ID. */
  readonly cardIds: Set<CardId>;
}

export interface IdConflict {
  readonly id: CardId;
  readonly paths: readonly string[];
}

export interface DeckIndex {
  /** Every unique, presentable card in any deck. */
  readonly cards: ReadonlyMap<CardId, ReviewCard>;
  /** Every deck: each trigger-matching tag and its parent paths down from the trigger. */
  readonly nodes: ReadonlyMap<string, DeckNode>;
  /**
   * The picker's rows: decks of tags written on a note (not parents only implied by a child tag),
   * in tag order. Every card in `all` belongs to at least one of them.
   */
  readonly listed: readonly DeckNode[];
  /** Union of all decks: every presentable card. */
  readonly all: ReadonlySet<CardId>;
  /** Adopted cards whose notes carry no trigger tag (count only). */
  readonly untagged: number;
  /** Same ID with different content: excluded from review, shown with every path. */
  readonly conflicts: readonly IdConflict[];
}

/** Whitespace-normalised effective content, as M1 compares cards. */
const contentKey = (card: { readonly question: string; readonly answer: string }): string =>
  `${card.question.replace(/\s+/gu, ' ').trim()}\u0000${card.answer.replace(/\s+/gu, ' ').trim()}`;

const byPath = (a: NoteCards, b: NoteCards): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

interface Occurrence {
  readonly id: CardId;
  readonly path: string;
  readonly question: string;
  readonly answer: string;
  readonly order: number;
  readonly deckTags: readonly string[];
}

export function buildDeckIndex(notes: readonly NoteCards[], triggers: readonly string[]): DeckIndex {
  const occurrences = new Map<CardId, Occurrence[]>();
  let order = 0;
  for (const note of [...notes].sort(byPath)) {
    for (const card of note.cards) {
      const list = occurrences.get(card.id) ?? [];
      list.push({ ...card, path: note.path, order: order += 1, deckTags: note.deckTags });
      occurrences.set(card.id, list);
    }
  }
  const cards = new Map<CardId, ReviewCard>();
  const conflicts: IdConflict[] = [];
  const nodes = new Map<string, DeckNode>();
  const triggerKeys = triggers.map(tagKey);
  const written = new Set<string>();
  let untagged = 0;
  for (const [id, list] of occurrences) {
    const first = list[0];
    if (!first) continue;
    if (list.some((item) => contentKey(item) !== contentKey(first))) {
      conflicts.push({ id, paths: [...new Set(list.map((item) => item.path))] });
      continue;
    }
    const tags = list.flatMap((item) => item.deckTags);
    if (!tags.length) {
      untagged += 1;
      continue;
    }
    cards.set(id, { id, path: first.path, question: first.question, answer: first.answer, order: first.order });
    for (const tag of tags) {
      const segments = tag.split('/');
      const keys = segments.map((_, index) => segments.slice(0, index + 1).join('/').toLowerCase());
      // Every prefix from the shortest matching trigger down to the tag itself is a deck.
      const start = keys.findIndex((key) => triggerKeys.includes(key));
      if (start < 0) continue;
      for (let index = start; index < keys.length; index += 1) {
        const key = keys[index] ?? '';
        let node = nodes.get(key);
        if (!node) {
          node = { key, label: segments.slice(0, index + 1).join('/'), cardIds: new Set() };
          nodes.set(key, node);
        }
        node.cardIds.add(id);
      }
      written.add(keys[keys.length - 1] ?? '');
    }
  }
  const listed = [...written].sort().flatMap((key) => nodes.get(key) ?? []);
  conflicts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cards, nodes, listed, all: new Set(cards.keys()), untagged, conflicts };
}
