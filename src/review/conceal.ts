/**
 * Before the answer is shown, nothing that could display other content is rendered (it might show
 * the answer, and heavy post-processors are avoided). Conservative: every `![` loses its `!`
 * (wiki and Markdown embeds, reference images, alt text with brackets), embedding HTML tags are
 * shown as text, fenced code loses its info string (so dataview and other code-block renderers do
 * not run; the code is shown as plain code), also inside blockquotes and (nested) list items, and
 * inline queries (`` `= …` ``, `` `$= …` ``) get a zero-width space so they stay plain code.
 */
export const hideEmbeds = (markdown: string): string => markdown
  .replace(/!\[/g, '[')
  .replace(/<(?=\s*\/?\s*(?:img|iframe|frame|frameset|portal|embed|object|video|audio|picture|source|svg|script|link|style)\b)/gi, '&lt;')
  .replace(/^([ \t]*(?:(?:>|[-*+]|\d+[.)])[ \t]*)*)(`{3,}|~{3,})[^\n`]*$/gm, '$1$2')
  .replace(/`(\$?=)/g, '`\u200B$1');
