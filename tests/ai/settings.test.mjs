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

  it('reads a stored consent only while it matches the current fingerprint (old data.json included)', () => {
    const cloud = 'gpt-oss:20b-cloud';
    const local = (extra) => parseAiSettings({ enabled: true, providers: { local: { model: cloud, ...extra } } }).providers.local.consent;
    const fingerprint = `local|ollama|http://localhost:11434|${cloud}`;
    expect(local({ consent: fingerprint })).toBe(fingerprint);
    // Left behind by earlier versions after a model change: read as no consent.
    expect(local({ consent: 'local|ollama|http://localhost:11434|gpt-oss:120b-cloud' })).toBeNull();
    expect(local({ server: 'llamacpp', baseUrl: 'http://localhost:11434', consent: fingerprint })).toBeNull();
    for (const consent of [true, 1, {}, '', null, undefined]) expect(local({ consent })).toBeNull();
    const jev = (model, consent) => parseAiSettings({ providers: { jev: { apiKey: KEY, model, consent } } }).providers.jev.consent;
    expect(jev(undefined, 'jev|api.typesafe.ai|jev-latest')).toBe('jev|api.typesafe.ai|jev-latest');
    expect(jev('jev-2', 'jev|api.typesafe.ai|jev-latest')).toBeNull();
    expect(jev(undefined, true)).toBeNull();
  });

  it('a change to the destination, server or model revokes consent: changing it back does not restore it (LEV-329)', async () => {
    const cloud = 'gpt-oss:20b-cloud';
    const fingerprint = `local|ollama|http://localhost:11434|${cloud}`;
    const saved = [];
    const store = new SettingsStore(async () => ({ ai: { enabled: true, providers: { local: { model: cloud, consent: fingerprint },
      jev: { apiKey: KEY, consent: 'jev|api.typesafe.ai|jev-latest' } } } }), async (data) => { saved.push(structuredClone(data)); });
    const withLocal = async (change) => {
      const { ai } = await store.get();
      return store.update({ ai: { ...ai, providers: { ...ai.providers, local: { ...ai.providers.local, ...change } } } });
    };
    expect(hasConsent('local', (await store.get()).ai)).toBe(true);
    for (const [away, back] of [[{ model: 'gpt-oss:120b-cloud' }, { model: cloud }],
      [{ baseUrl: 'http://127.0.0.1:11434' }, { baseUrl: 'http://localhost:11434' }],
      [{ server: 'llamacpp' }, { server: 'ollama' }]]) {
      await withLocal({ consent: fingerprint });
      expect(saved.at(-1).ai.providers.local.consent).toBe(fingerprint);
      await withLocal(away);
      expect(saved.at(-1).ai.providers.local.consent).toBeNull();
      const restored = await withLocal(back);
      expect(restored.ai.providers.local).toMatchObject({ model: cloud, baseUrl: 'http://localhost:11434', server: 'ollama', consent: null });
      expect(saved.at(-1).ai.providers.local.consent).toBeNull();
      expect(hasConsent('local', restored.ai)).toBe(false);
    }
    // Jev's consent belongs to Jev: the local changes above never touched it.
    expect(saved.at(-1).ai.providers.jev.consent).toBe('jev|api.typesafe.ai|jev-latest');
  });

  it('saves run one at a time: a change and revert sent before the first save finishes still revokes consent', async () => {
    const cloud = 'gpt-oss:20b-cloud';
    const fingerprint = `local|ollama|http://localhost:11434|${cloud}`;
    let disk = { ai: { enabled: true, providers: { local: { model: cloud, consent: fingerprint } } } };
    const order = [];
    // A slow data.json write (synced vault, slow disk): the revert is sent while the change is still saving.
    const store = new SettingsStore(async () => structuredClone(disk), async (data) => {
      order.push(`start ${data.ai.providers.local.model}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      disk = structuredClone(data); order.push(`end ${data.ai.providers.local.model}`);
    });
    await store.get();
    const model = (value) => store.update((latest) => ({ ai: { ...latest.ai, providers: { ...latest.ai.providers,
      local: { ...latest.ai.providers.local, model: value } } } }));
    const results = await Promise.all([model('gpt-oss:120b-cloud'), model(cloud)]);
    expect(order).toEqual(['start gpt-oss:120b-cloud', 'end gpt-oss:120b-cloud', `start ${cloud}`, `end ${cloud}`]);
    expect(results.map((settings) => settings.ai.providers.local.consent)).toEqual([null, null]);
    expect(disk.ai.providers.local).toMatchObject({ model: cloud, consent: null });
    expect(hasConsent('local', (await store.get()).ai)).toBe(false);
    // A failed save does not block the next one.
    const failing = new SettingsStore(async () => ({}), async (data) => { if (data.triggerTags[0] === 'x') throw new Error('EACCES'); });
    await expect(failing.update({ triggerTags: ['x'] })).rejects.toThrow('EACCES');
    expect((await failing.update({ triggerTags: ['y'] })).triggerTags).toEqual(['y']);
  });

  it('a stale consent from an earlier version is never revived and is cleared by the next save', async () => {
    const saved = [];
    const store = new SettingsStore(async () => ({ ai: { enabled: true,
      providers: { local: { model: 'qwen3:8b', consent: 'local|ollama|http://localhost:11434|gpt-oss:20b-cloud' } } } }),
    async (data) => { saved.push(structuredClone(data)); });
    expect((await store.get()).ai.providers.local.consent).toBeNull();
    expect(saved).toEqual([]);
    await store.update({ triggerTags: ['英単語'] });
    expect(saved.at(-1).ai.providers.local.consent).toBeNull();
    const { ai } = await store.get();
    const back = await store.update({ ai: { ...ai, providers: { ...ai.providers, local: { ...ai.providers.local, model: 'gpt-oss:20b-cloud' } } } });
    expect(hasConsent('local', back.ai)).toBe(false);
  });

  it('shows at most the last 4 characters of a key, nothing of a short one', () => {
    expect(maskedKey(KEY)).toBe('…CRET');
    expect(maskedKey('short')).toBe('（設定済み）');
    expect(maskedKey('')).toBe('');
  });
});
