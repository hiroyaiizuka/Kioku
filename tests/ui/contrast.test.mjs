// Text contrast of the deck picker and review screen colors in styles.css (WCAG 2 relative luminance).
// The backgrounds are Obsidian 1.14.4's default --modal-background, read in the dedicated instance (LEV-322).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('styles.css', 'utf8');
const BACKGROUND = { dark: '#1c1c1c', light: '#ffffff' };
/** The approved LEV-321 count colors; a theme override may move only their lightness. */
const APPROVED = { new: '#4f8fd6', learn: '#c8574f', due: '#5f9a46' };

/** Declarations (custom properties included) of the rule with exactly this selector. */
function properties(selector) {
  const start = CSS.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  const body = CSS.slice(CSS.indexOf('{', start) + 1, CSS.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

const rgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const hueSaturation = (hex) => {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s];
};

const base = properties('.kioku-deck-picker-modal');
const themes = { dark: properties('body.theme-dark .kioku-deck-picker-modal'), light: properties('body.theme-light .kioku-deck-picker-modal') };

describe('color contrast (4.5:1, WCAG AA for normal text)', () => {
  it('keeps white text on the rating buttons and the progress pill at 4.5:1 or more', () => {
    const fills = ['again', 'hard', 'good', 'easy'].map((grade) => base[`--kioku-rating-${grade}`]);
    expect(fills).toEqual(['#c54e45', '#936e26', '#22807f', '#3274c8']);
    for (const fill of [...fills, base['--kioku-progress-bg']]) expect(contrast(base['--kioku-progress-fg'], fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the interval and the key badge fully white on the buttons, and the hover darker (still 4.5:1)', () => {
    // Opacity would blend the white text into the fill and drop it below 4.5:1 (0.85 → 3.78 on もう一度).
    expect(properties('.kioku-deck-picker-modal .kioku-review-interval').opacity).toBeUndefined();
    expect(properties('.kioku-deck-picker-modal .kioku-review-grade .kioku-review-key').opacity).toBe('1');
    const hover = properties('.kioku-deck-picker-modal .kioku-review-grade:hover:not(:disabled)').background;
    const [, share, mixWith] = hover.match(/^color-mix\(in srgb, var\(--kioku-rating-color\) (\d+)%, (#[0-9a-f]{6})\)$/);
    for (const grade of ['again', 'hard', 'good', 'easy']) {
      const fill = rgb(base[`--kioku-rating-${grade}`]);
      const other = rgb(mixWith);
      const mixed = `#${fill.map((c, index) => Math.round(255 * (c * share / 100 + other[index] * (1 - share / 100))).toString(16).padStart(2, '0')).join('')}`;
      expect(contrast('#ffffff', mixed), `${grade} hover ${mixed}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  for (const theme of ['dark', 'light']) {
    it(`keeps the 新規 / 学習中 / 復習 counts at 4.5:1 or more on the ${theme} modal background, moving lightness only`, () => {
      for (const [kind, approved] of Object.entries(APPROVED)) {
        const color = themes[theme][`--kioku-deck-${kind}-color`] ?? base[`--kioku-deck-${kind}-color`];
        expect(base[`--kioku-deck-${kind}-color`]).toBe(approved);
        expect(contrast(color, BACKGROUND[theme]), `${theme} ${kind} ${color}`).toBeGreaterThanOrEqual(4.5);
        const [hue, saturation] = hueSaturation(color);
        const [approvedHue, approvedSaturation] = hueSaturation(approved);
        expect(Math.abs(hue - approvedHue), `${theme} ${kind} hue`).toBeLessThan(1);
        expect(Math.abs(saturation - approvedSaturation), `${theme} ${kind} saturation`).toBeLessThan(0.02);
      }
    });
  }
});
