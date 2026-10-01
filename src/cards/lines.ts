/** One physical line of a note. Offsets are UTF-16 offsets into the original string. */
export interface Line {
  readonly text: string;
  /** Offset of the first character of the line. */
  readonly start: number;
  /** Offset just after the last content character (before the line break). */
  readonly end: number;
  /** The original line break (`\r\n`, `\n`, `\r`) or `''` for the last line. */
  readonly eol: string;
}

const LINE_BREAK = /\r\n|\r|\n/g;

/** Splits on CRLF, LF and CR while preserving exact offsets and line breaks. */
export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const match of text.matchAll(LINE_BREAK)) {
    const index = match.index;
    lines.push({ text: text.slice(start, index), start, end: index, eol: match[0] });
    start = index + match[0].length;
  }
  lines.push({ text: text.slice(start), start, end: text.length, eol: '' });
  return lines;
}

/** The first line break used by the note, so inserted text matches the note's convention. */
export function detectEol(text: string): string {
  return text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
}

export const isBlank = (text: string): boolean => text.trim() === '';
