import { parseFrontMatterTags, type App } from 'obsidian';
import { splitLines } from '../cards/lines';
import { CARD_ID_PREFIX, extractCandidates } from '../cards/parser';
import { classifyLines } from '../cards/regions';
import { errorMessage } from '../cards/error-message';
import { isCardId } from '../store/schema';
import type { NoteCards } from './index';
import { deckTagsOfNote, matchesTrigger } from './tags';

export interface ScanResult {
  readonly notes: NoteCards[];
  /** Notes that could not be read (path and reason). */
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
  readonly scannedNotes: number;
  /** Notes skipped because the metadata cache has no entry yet (still indexing). */
  readonly notIndexed: number;
  /** `^kioku-…` block IDs that are not valid card IDs (e.g. `^kioku-`); never presented. */
  readonly invalidIds: readonly { readonly path: string; readonly id: string }[];
}

/**
 * Read-only scan, run only when the deck picker opens. Notes are pre-selected from the metadata
 * cache: a trigger tag anywhere (decks), or a `kioku-` block ID (to count cards outside decks).
 * Every trigger-tagged note is read even without a `kioku-` key in `cache.blocks`, because whether
 * list-item block IDs always appear there is not yet verified natively (docs/m2-design.md §3.3).
 * Candidates are then parsed with the M1 parser; tags inside M1 exclusion regions do not count.
 */
export async function scanVault(app: App, triggers: readonly string[]): Promise<ScanResult> {
  const notes: NoteCards[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  const invalidIds: { path: string; id: string }[] = [];
  let scannedNotes = 0;
  let notIndexed = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) {
      notIndexed += 1;
      continue;
    }
    const frontmatterTags = parseFrontMatterTags(cache.frontmatter) ?? [];
    const bodyTags = (cache.tags ?? []).map((item) => ({ tag: item.tag, line: item.position.start.line }));
    const tagged = [...frontmatterTags, ...bodyTags.map((item) => item.tag)].some((tag) => matchesTrigger(tag, triggers));
    const hasCardBlock = Object.keys(cache.blocks ?? {}).some((key) => key.toLowerCase().startsWith(CARD_ID_PREFIX));
    if (!tagged && !hasCardBlock) continue;
    scannedNotes += 1;
    let text: string;
    try {
      text = await app.vault.cachedRead(file);
    } catch (error) {
      unreadable.push({ path: file.path, reason: errorMessage(error) });
      continue;
    }
    const kinds = classifyLines(splitLines(text));
    const deckTags = deckTagsOfNote(frontmatterTags, bodyTags, (line) => (kinds[line] ?? null) !== null, triggers);
    const adopted = extractCandidates(text)
      .filter((item) => item.cardId !== null && (item.status === 'adopted' || item.status === 'duplicate-id'));
    for (const item of adopted) if (!isCardId(item.cardId)) invalidIds.push({ path: file.path, id: item.cardId ?? '' });
    const cards = adopted.filter((item) => isCardId(item.cardId))
      .map((item) => ({ id: item.cardId ?? '', ...(item.edit ?? { question: item.question, answer: item.answer }) }));
    if (cards.length) notes.push({ path: file.path, deckTags, cards });
  }
  return { notes, unreadable, scannedNotes, invalidIds, notIndexed };
}
