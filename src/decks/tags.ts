// Trigger-tag matching. Pure: tag syntax itself comes from Obsidian's metadata cache, never from here.

/** Tag without `#`, lower-cased: Obsidian tags are case-insensitive. */
export const tagKey = (tag: string): string => tag.replace(/^#/, '').toLowerCase();

/** A setting value as a tag body: no `#`, no surrounding or trailing `/`. `null` when unusable. */
export function cleanTag(input: string): string | null {
  const tag = input.trim().replace(/^#+/, '').replace(/^\/+|\/+$/g, '');
  // Obsidian rejects whitespace and purely numeric tags; empty path segments never match a real tag.
  if (!tag || /\s/.test(tag) || /^\d+$/.test(tag) || tag.split('/').some((segment) => !segment)) return null;
  return tag;
}

/** Cleans and de-duplicates (case-insensitively, first spelling wins) trigger tags from settings. */
export function normalizeTriggerTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    const tag = cleanTag(raw);
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      result.push(tag);
    }
  }
  return result;
}

/** `#kioku` and `#kioku/医学` match the trigger `kioku`; `#kiokux` does not. */
export function matchesTrigger(tag: string, triggers: readonly string[]): boolean {
  const key = tagKey(tag);
  return triggers.some((trigger) => {
    const root = tagKey(trigger);
    return key === root || key.startsWith(`${root}/`);
  });
}

export interface BodyTag {
  /** As in `CachedMetadata.tags[].tag`, with `#`. */
  readonly tag: string;
  /** 0-based line of the tag. */
  readonly line: number;
}

/**
 * The note's deck tags (without `#`, first spelling per tag): frontmatter tags plus body tags
 * outside M1's exclusion regions (code, `%%`, HTML comments, `$$`, Excalidraw data).
 */
export function deckTagsOfNote(frontmatterTags: readonly string[] | null, bodyTags: readonly BodyTag[],
  isExcludedLine: (line: number) => boolean, triggers: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (raw: string): void => {
    const tag = raw.replace(/^#/, '');
    if (!tag || !matchesTrigger(tag, triggers) || seen.has(tagKey(tag))) return;
    seen.add(tagKey(tag));
    result.push(tag);
  };
  for (const tag of frontmatterTags ?? []) add(tag);
  for (const tag of bodyTags) if (!isExcludedLine(tag.line)) add(tag.tag);
  return result;
}
