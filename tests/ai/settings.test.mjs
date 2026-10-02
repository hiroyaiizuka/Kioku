import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_SETTINGS, consentFingerprint, hasConsent, isCloudModel, isLoopbackHost, localIsExternal, maskedKey,
  normalizeBaseUrl, parseAiSettings } from '../../src/ai/settings.ts';
import { SettingsStore } from '../../src/store/settings.ts';

const KEY = 'tsk-live-0123456789abcdefSECRET';

describe('ai settings (data.json `ai` section)', () => {
  it('defaults to AI off, Jev preselected as judge, Ollama on localhost without a model', () => {
    expect(parseAiSettings(undefined)).toEqual(DEFAULT_AI_SETTINGS);
    expect(DEFAULT_AI_SETTINGS).toMatchObject({ enabled: false, judge: 'jev', generator: 'local',
      providers: { local: { server: 'ollama', baseUrl: 'http://localhost:11434', model: '', consent: null },
        jev: { apiKey: '', model: 'jev-latest', consent: null } }, timeouts: { judgeSeconds: 20, generateSeconds: 60 } });
  });

  it('reads valid fields and falls back for invalid ones', () => {
    const parsed = parseAiSettings({ enabled: true, judge: 'none', providers: { local: { server: 'lmstudio', baseUrl: 'ftp://x', model: ' qwen ' },
      jev: { apiKey: ` ${KEY} `, model: '' } }, timeouts: { judgeSeconds: 0, generateSeconds: 90 } });
    expect(parsed).toMatchObject({ enabled: true, judge: 'none',
      providers: { local: { server: 'lmstudio', baseUrl: 'http://localhost:1234', model: 'qwen' }, jev: { apiKey: KEY, model: 'jev-latest' } },
      timeouts: { judgeSeconds: 20, generateSeconds: 90 } });
    expect(normalizeBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeBaseUrl('http://user:pw@host')).toBeNull();
    // A path would be doubled by the endpoint Kioku appends (`/v1/v1/chat/completions`).
    expect(['http://localhost:11434/v1', 'http://localhost:11434/v1/', 'http://localhost:1234/api'].map(normalizeBaseUrl)).toEqual([null, null, null]);
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(parseAiSettings({ providers: { local: { baseUrl: 'http://localhost:11434/v1' } } }).providers.local.baseUrl).toBe('http://localhost:11434');
  });

  it('keeps the ai section when another setting is saved, and an M2 data.json loads with AI off', async () => {
    const saved = [];
    const ai = { enabled: true, judge: 'jev', providers: { jev: { apiKey: KEY, consent: 'jev|api.typesafe.ai|jev-latest' } } };
    const store = new SettingsStore(async () => ({ schemaVersion: 1, triggerTags: ['kioku'], ai }), async (data) => { saved.push(data); });
    await store.update({ triggerTags: ['英単語'] });
    expect(saved[0].triggerTags).toEqual(['英単語']);
    expect(saved[0].ai.providers.jev).toMatchObject({ apiKey: KEY, consent: 'jev|api.typesafe.ai|jev-latest' });
    expect(saved[0].ai.enabled).toBe(true);
    const m2 = new SettingsStore(async () => ({ schemaVersion: 1, triggerTags: ['kioku'], dayStartHour: 4, newPerDay: 20, dataFolder: 'Kioku' }),
      async () => {});
    expect((await m2.get()).ai).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('treats non-loopback hosts and Ollama cloud models as external', () => {
    expect(['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1'].every(isLoopbackHost)).toBe(true);
    expect(['192.168.1.5', 'example.com', 'localhost.example.com', '0.0.0.0'].some(isLoopbackHost)).toBe(false);
    expect(['gpt-oss:120b-cloud', 'deepseek-v3.1:671b-cloud', 'qwen3-coder:cloud', 'X:CLOUD'].every(isCloudModel)).toBe(true);
    expect(['qwen3:8b', 'cloudy:7b', 'llama3'].some(isCloudModel)).toBe(false);
    const local = DEFAULT_AI_SETTINGS.providers.local;
    expect(localIsExternal({ ...local, model: 'qwen3:8b' })).toBe(false);
    expect(localIsExternal({ ...local, model: 'gpt-oss:20b-cloud' })).toBe(true);
    expect(localIsExternal({ ...local, baseUrl: 'http://192.168.1.5:11434', model: 'qwen3:8b' })).toBe(true);
    expect(localIsExternal({ ...local, baseUrl: 'http://0.0.0.0:11434', model: 'qwen3:8b' })).toBe(true);
    // The cloud name rule applies to every server type (another server may proxy to Ollama).
    expect(localIsExternal({ ...local, server: 'llamacpp', baseUrl: 'http://localhost:8080', model: 'gpt-oss:20b-cloud' })).toBe(true);
    expect(localIsExternal({ ...local, server: 'lmstudio', baseUrl: 'http://localhost:1234', model: 'qwen-cloud' })).toBe(true);
  });

  it('invalidates consent when the destination or model changes', () => {
    const base = parseAiSettings({ enabled: true, providers: { local: { model: 'gpt-oss:20b-cloud' } } });
    const consented = { ...base, providers: { ...base.providers, local: { ...base.providers.local, consent: consentFingerprint('local', base) } } };
    expect(hasConsent('local', base)).toBe(false);
    expect(hasConsent('local', consented)).toBe(true);
    const otherModel = { ...consented, providers: { ...consented.providers, local: { ...consented.providers.local, model: 'gpt-oss:120b-cloud' } } };
    expect(hasConsent('local', otherModel)).toBe(false);
    const otherUrl = { ...consented, providers: { ...consented.providers, local: { ...consented.providers.local, baseUrl: 'http://127.0.0.1:11434' } } };
    expect(hasConsent('local', otherUrl)).toBe(false);
  });

  it('shows at most the last 4 characters of a key, nothing of a short one', () => {
    expect(maskedKey(KEY)).toBe('…CRET');
    expect(maskedKey('short')).toBe('（設定済み）');
    expect(maskedKey('')).toBe('');
  });
});
