import { describe, expect, it } from 'vitest';
import { hideEmbeds } from '../../src/review/conceal.ts';

describe('hiding embeds before the answer is shown', () => {
  it('turns every embed form into a link or text and disables code-block renderers', () => {
    expect(hideEmbeds('![[note#^kioku-a]] ![alt](x.png) ![a][ref] ![x [1]](y.png)'))
      .toBe('[[note#^kioku-a]] [alt](x.png) [a][ref] [x [1]](y.png)');
    expect(hideEmbeds('<img src="a.png"> <IFRAME src="b"></iframe> <video> <b>ok</b>'))
      .toBe('&lt;img src="a.png"> &lt;IFRAME src="b">&lt;/iframe> &lt;video> <b>ok</b>');
    expect(hideEmbeds('```dataview\nLIST\n```\n> ~~~mermaid\n> graph\n> ~~~')).toBe('```\nLIST\n```\n> ~~~\n> graph\n> ~~~');
    expect(hideEmbeds('普通の問い？')).toBe('普通の問い？');
  });
  it('also strips fence info strings inside (nested) list items and blockquote + list combinations', () => {
    for (const [input, output] of [
      ['- ```dataview\nLIST\n- ```', '- ```\nLIST\n- ```'],
      ['1. ~~~query\nx\n~~~', '1. ~~~\nx\n~~~'],
      ['2) ```dataviewjs', '2) ```'],
      ['    - ```tasks', '    - ```'],
      ['- * + ```mermaid', '- * + ```'],
      ['> - ```dataview', '> - ```'],
      ['>> 1. ~~~query', '>> 1. ~~~'],
      ['\t- ```dataview {x}', '\t- ```'],
    ]) expect(hideEmbeds(input)).toBe(output);
    expect(hideEmbeds('- 普通の項目')).toBe('- 普通の項目');
  });
  it('neutralises inline queries and every embedding HTML tag', () => {
    expect(hideEmbeds('値は `= this.answer` と `$= dv.current().a`、`code` はそのまま'))
      .toBe('値は `\u200B= this.answer` と `\u200B$= dv.current().a`、`code` はそのまま');
    for (const tag of ['frame', 'frameset', 'portal', 'object', 'embed', 'video', 'audio', 'iframe', 'img']) {
      expect(hideEmbeds(`<${tag} src="a">`)).toBe(`&lt;${tag} src="a">`);
    }
  });
});
