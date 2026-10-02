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
});
