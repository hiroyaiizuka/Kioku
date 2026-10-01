import type { Line } from './lines';

/** Why a line is excluded from Q/A extraction. `null` means the line is ordinary note text. */
export type ExclusionKind = 'frontmatter' | 'fence' | 'comment' | 'excalidraw' | null;

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const EXCALIDRAW_KEY = /^excalidraw-plugin\s*:/;
const EXCALIDRAW_SECTION = /^#{1,2} (?:Excalidraw Data|Text Elements|Drawing|Embedded [Ff]iles)\s*$/;

function commentMarkers(text: string): number {
  return text.split('%%').length - 1;
}

/**
 * Classifies every line. Excluded lines are never candidates and never write targets.
 * The scan is deliberately conservative: when in doubt (indented fences, `%%` inside
 * inline code) more text is excluded, never less.
 */
export function classifyLines(lines: readonly Line[]): ExclusionKind[] {
  const kinds: ExclusionKind[] = lines.map(() => null);
  let index = 0;
  let excalidraw = false;
  if (lines[0]?.text.trimEnd() === '---') {
    for (let close = 1; close < lines.length; close += 1) {
      const text = lines[close]?.text.trimEnd();
      if (text === '---' || text === '...') {
        for (let line = 0; line <= close; line += 1) kinds[line] = 'frontmatter';
        excalidraw = lines.slice(1, close).some((line) => EXCALIDRAW_KEY.test(line.text));
        index = close + 1;
        break;
      }
    }
  }
  let fence: { readonly char: string; readonly length: number } | null = null;
  let comment = false;
  for (; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? '';
    if (fence) {
      kinds[index] = 'fence';
      const close = text.match(FENCE_CLOSE)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      continue;
    }
    if (comment) {
      kinds[index] = 'comment';
      if (commentMarkers(text) % 2 === 1) comment = false;
      continue;
    }
    const open = text.match(FENCE_OPEN)?.[1];
    if (open) {
      kinds[index] = 'fence';
      fence = { char: open[0] ?? '`', length: open.length };
      continue;
    }
    if (commentMarkers(text) % 2 === 1) {
      kinds[index] = 'comment';
      comment = true;
      continue;
    }
    if (excalidraw && EXCALIDRAW_SECTION.test(text)) {
      for (let rest = index; rest < lines.length; rest += 1) kinds[rest] = 'excalidraw';
      break;
    }
  }
  return kinds;
}
