// Settings live in the plugin's data.json (Plugin.loadData / saveData); review data never does.
import { normalizeTriggerTags } from '../decks/tags';
import type { KiokuSettings } from '../review/types';

export const DEFAULT_SETTINGS: KiokuSettings = {
  schemaVersion: 1,
  triggerTags: ['kioku'],
  dayStartHour: 4,
  newPerDay: 20,
  dataFolder: 'Kioku',
};

export const MAX_NEW_PER_DAY = 9999;

/**
 * A vault-relative folder without leading / trailing slashes, or null when unusable: empty,
 * `.`/`..` segments, hidden first segment (e.g. `.obsidian`), or characters Obsidian disallows.
 */
export function normalizeDataFolder(input: string): string | null {
  const segments = input.trim().replace(/\\/g, '/').split('/').map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === '.' || segment === '..' || /[*"<>:|?]/.test(segment))) return null;
  if (segments[0]?.startsWith('.')) return null;
  return segments.join('/');
}

/** Reads data.json leniently: every missing or invalid field falls back to its default. */
export function parseSettings(raw: unknown): KiokuSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const tags = Array.isArray(value.triggerTags)
    ? normalizeTriggerTags(value.triggerTags.filter((tag): tag is string => typeof tag === 'string')) : [];
  const hour = value.dayStartHour;
  const perDay = value.newPerDay;
  const folder = typeof value.dataFolder === 'string' ? normalizeDataFolder(value.dataFolder) : null;
  return {
    schemaVersion: 1,
    triggerTags: tags.length ? tags : DEFAULT_SETTINGS.triggerTags,
    dayStartHour: Number.isInteger(hour) && (hour as number) >= 0 && (hour as number) <= 23 ? hour as number : DEFAULT_SETTINGS.dayStartHour,
    newPerDay: perDay === null ? null
      : Number.isInteger(perDay) && (perDay as number) >= 0 && (perDay as number) <= MAX_NEW_PER_DAY ? perDay as number
        : DEFAULT_SETTINGS.newPerDay,
    dataFolder: folder ?? DEFAULT_SETTINGS.dataFolder,
  };
}

export type SettingsPatch = Partial<Omit<KiokuSettings, 'schemaVersion'>>;

/** Lazily loaded settings (no data.json read at startup), saved through the plugin's saveData. */
export class SettingsStore {
  private current: Promise<KiokuSettings> | null = null;

  constructor(private readonly loadData: () => Promise<unknown>,
    private readonly saveData: (data: KiokuSettings) => Promise<void>) {}

  get(): Promise<KiokuSettings> {
    this.current ??= this.loadData().then(parseSettings, () => DEFAULT_SETTINGS);
    return this.current;
  }

  async update(patch: SettingsPatch): Promise<KiokuSettings> {
    const next = parseSettings({ ...(await this.get()), ...patch });
    await this.saveData(next);
    this.current = Promise.resolve(next);
    return next;
  }
}
