// The optional `ai` section of data.json (docs/m3-design.md §7, Q5). Pure parsing and the
// external / consent rules; no I/O.

export type LocalServer = 'ollama' | 'llamacpp' | 'lmstudio';
export type JudgeChoice = 'jev' | 'none';

export interface LocalProviderSettings {
  readonly server: LocalServer;
  /** Host and port only (paths are appended per server). */
  readonly baseUrl: string;
  /** Generation model; empty = generation not configured (no default model, Q1). */
  readonly model: string;
  /** Consent fingerprint (`consentFingerprint`) the user agreed to, or null. Needed only when external. */
  readonly consent: string | null;
}

export interface JevProviderSettings {
  /** Stored in plain text in data.json (Q5, §7.3). Never logged or shown in full. */
  readonly apiKey: string;
  readonly model: string;
  readonly consent: string | null;
}

export interface AiSettings {
  /** Off by default (S1). */
  readonly enabled: boolean;
  /** Jev is preselected when AI is enabled; `none` = deterministic checks only (§5.2). */
  readonly judge: JudgeChoice;
  /** Phase A has one generator kind: an OpenAI-compatible local server (Q1). */
  readonly generator: 'local';
  readonly providers: { readonly local: LocalProviderSettings; readonly jev: JevProviderSettings };
  readonly timeouts: { readonly judgeSeconds: number; readonly generateSeconds: number };
}

export const LOCAL_DEFAULT_URLS: Readonly<Record<LocalServer, string>> = {
  ollama: 'http://localhost:11434',
  llamacpp: 'http://localhost:8080',
  lmstudio: 'http://localhost:1234',
};

export const LOCAL_SERVER_LABELS: Readonly<Record<LocalServer, string>> = {
  ollama: 'Ollama',
  llamacpp: 'llama.cpp',
  lmstudio: 'LM Studio',
};

export const JEV_HOST = 'api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-latest';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  judge: 'jev',
  generator: 'local',
  providers: {
    local: { server: 'ollama', baseUrl: LOCAL_DEFAULT_URLS.ollama, model: '', consent: null },
    jev: { apiKey: '', model: JEV_DEFAULT_MODEL, consent: null },
  },
  timeouts: { judgeSeconds: 20, generateSeconds: 60 },
};

const record = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value.trim() : fallback);
const consentOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const seconds = (value: unknown, fallback: number): number =>
  (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 600 ? value as number : fallback);

/**
 * `http(s)://host[:port]`, or null when unusable. A path (e.g. `/v1`) is refused rather than kept:
 * Kioku appends the endpoint path itself, so `http://localhost:11434/v1` would become `/v1/v1/…`.
 */
export function normalizeBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return `${url.protocol}//${url.host}`;
}

/** Reads the `ai` section leniently; anything missing or invalid falls back to AI off / defaults. */
export function parseAiSettings(raw: unknown): AiSettings {
  const value = record(raw);
  const providers = record(value.providers);
  const local = record(providers.local);
  const jev = record(providers.jev);
  const timeouts = record(value.timeouts);
  const server: LocalServer = local.server === 'llamacpp' || local.server === 'lmstudio' ? local.server : 'ollama';
  const baseUrl = typeof local.baseUrl === 'string' ? normalizeBaseUrl(local.baseUrl) : null;
  return {
    enabled: value.enabled === true,
    judge: value.judge === 'none' ? 'none' : 'jev',
    generator: 'local',
    providers: {
      local: { server, baseUrl: baseUrl ?? LOCAL_DEFAULT_URLS[server], model: text(local.model, ''), consent: consentOf(local.consent) },
      jev: { apiKey: text(jev.apiKey, ''), model: text(jev.model, '') || JEV_DEFAULT_MODEL, consent: consentOf(jev.consent) },
    },
    timeouts: {
      judgeSeconds: seconds(timeouts.judgeSeconds, DEFAULT_AI_SETTINGS.timeouts.judgeSeconds),
      generateSeconds: seconds(timeouts.generateSeconds, DEFAULT_AI_SETTINGS.timeouts.generateSeconds),
    },
  };
}

/**
 * True for localhost, 127.0.0.0/8 and ::1. Anything else is external, including LAN hosts and
 * `0.0.0.0` (a listen-on-all address, not a destination Kioku can prove is this computer).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Ollama cloud models run on Ollama's servers even through localhost (§3.4, Q6). Detected by the
 * name only (`:cloud` / `-cloud` suffix); whether `/api/show` can tell is unverified. Applied to
 * every server type (erring toward external): another server may proxy to Ollama.
 */
export function isCloudModel(model: string): boolean {
  return /[:-]cloud$/i.test(model.trim());
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function localIsExternal(local: LocalProviderSettings): boolean {
  let hostname = '';
  try {
    hostname = new URL(local.baseUrl).hostname;
  } catch {
    return true;
  }
  return !isLoopbackHost(hostname) || isCloudModel(local.model);
}

/**
 * What a consent covers. Changing the provider's destination or model changes the fingerprint,
 * so consent must be given again (§7.1).
 */
export function consentFingerprint(provider: 'local' | 'jev', settings: AiSettings): string {
  if (provider === 'jev') return `jev|${JEV_HOST}|${settings.providers.jev.model}`;
  const { server, baseUrl, model } = settings.providers.local;
  return `local|${server}|${baseUrl}|${model}`;
}

export const hasConsent = (provider: 'local' | 'jev', settings: AiSettings): boolean =>
  settings.providers[provider].consent === consentFingerprint(provider, settings);

/** The last 4 characters of a stored key, for display only (nothing of a short key). */
export const maskedKey = (key: string): string => {
  if (!key) return '';
  return key.length >= 12 ? `…${key.slice(-4)}` : '（設定済み）';
};
