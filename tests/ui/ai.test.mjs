// Real plugin source bundled against public-API doubles (requestUrl included). Proves the M3 UI
// contract — no network until the run button, consent and preview before external sending, cancel,
// adoption through the M1 write path — not native Obsidian behaviour or any real AI service.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEditor, MockMarkdownView, MockTFile, compilePlugin, createApp, installDom, network } from '../helpers/obsidian-mock.mjs';

const KEY = 'tsk-live-0123456789abcdefSECRETKEY';
const NOTE = [
  '# 光合成',
  '光合成は糖を作る反応である。葉緑体で行われる。',
  '',
  'ミトコンドリアは呼吸の場である。',
  '',
].join('\n');
const CARDS = { cards: [
  { fact: 'f1', question: '光合成の場は？', answer: '葉緑体', quote: '葉緑体で行われる。' },
  { fact: 'f2', question: '呼吸の場は？', answer: 'ミトコンドリア', quote: 'ミトコンドリアは呼吸の場である。' },
  { fact: 'f3', question: '捏造の問い', answer: '捏造', quote: 'ノートに無い引用。' },
] };
const chat = (content) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
const jev = (supported) => ({ status: 200, text: JSON.stringify({ answers: {
  supported: { noul: supported }, answerable: { noul: 0.9 }, one_fact: { noul: 0.9 },
  quality: { type: 'score', score: 3.05, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' }, probabilities: { 3: 0.95, 4: 0.05 }, confidence: 0.9 } } }) });

let dom;
let Plugin;
let notices;
beforeEach(async () => {
  dom = installDom(); notices = [];
  Plugin = await compilePlugin(readFileSync('src/main.ts', 'utf8'), notices);
  // Date is faked too, so the 「生成中…（N 秒）」 counter (Date.now) moves with the fake timers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); dom.window.close(); delete globalThis.document; delete globalThis.window; });

const flush = () => vi.advanceTimersByTimeAsync(0);
const settle = () => vi.advanceTimersByTimeAsync(7000);
const ai = (overrides = {}) => ({ enabled: true, judge: 'jev', providers: { local: { model: 'qwen3:8b' } }, ...overrides });

function open(data, text = NOTE) {
  const file = new MockTFile('学習/生物.md');
  const editor = new FakeEditor(text);
  const view = new MockMarkdownView(file, editor, 'source');
  const app = createApp({ files: { [file.path]: text }, views: [view], active: view });
  const plugin = new Plugin(app); plugin.data = data; plugin.onload();
  return { app, plugin, editor };
}
async function extract(plugin) {
  plugin.commands.find((command) => command.id === 'extract-explicit-qa').checkCallback(false);
  await flush();
}
const section = () => document.querySelector('.kioku-ai-section');
const generated = () => [...document.querySelectorAll('.kioku-generated')];

describe('AI section of the candidate popup', () => {
  it('without AI settings explains how to set it up and never touches the network', async () => {
    const { plugin } = open(null);
    await extract(plugin);
    expect(section().querySelector('.kioku-ai-guidance').textContent).toContain('AI が未設定のため、ノートに書いた問い・答えだけを表示しています。設定 → Kioku → AI');
    expect(section().querySelector('.kioku-ai-run')).toBeNull();
    expect(network.calls).toEqual([]);
  });

  it('with only a local generator: sends to localhost on click, shows checked candidates as 未判定（Jev 未設定）, adopts one', async () => {
    const { plugin, editor } = open({ ai: ai() });
    network.respond = () => chat(CARDS);
    await extract(plugin);
    expect(network.calls).toEqual([]);
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain('このパソコン localhost:11434');
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain('判定：なし（Jev 未設定）');
    const run = section().querySelector('.kioku-ai-run');
    expect(run.textContent).toBe('AI で候補を作る');
    run.click(); await flush();
    expect(network.calls.map((call) => call.url)).toEqual(['http://localhost:11434/v1/chat/completions']);
    expect(network.calls[0].body).not.toContain('生物');
    expect(generated().map((item) => item.querySelector('.kioku-ai-badge').textContent)).toEqual(['未判定（Jev 未設定）', '未判定（Jev 未設定）']);
    expect(section().querySelector('.kioku-ai-status').textContent).toContain('原文に見つからない引用のため除外 1 件');
    expect(generated()[0].querySelector('.kioku-ai-insert-preview').textContent).toBe('Q: 光合成の場は？\nA: 葉緑体 ^kioku-…\n\n%%kioku-src:kioku-…\n葉緑体で行われる。\n%%');

    generated()[0].querySelector('.kioku-candidate-adopt').click(); await settle();
    expect(editor.transactions).toHaveLength(1);
    expect(editor.getValue()).toMatch(/^# 光合成\n光合成は糖を作る反応である。葉緑体で行われる。\n\nQ: 光合成の場は？\nA: 葉緑体 \^(kioku-[0-9a-z]{10})\n\n%%kioku-src:\1\n葉緑体で行われる。\n%%\n\nミトコンドリアは呼吸の場である。\n$/);
    expect(notices.at(-1)).toMatch(/^Kioku：採用しました（kioku-[0-9a-z]{10}）。$/);
    // The second card still adopts after the first insertion shifted the text.
    generated()[1].querySelector('.kioku-candidate-adopt').click(); await settle();
    expect(editor.getValue()).toMatch(/ミトコンドリアは呼吸の場である。\n\nQ: 呼吸の場は？\nA: ミトコンドリア \^kioku-/);
    expect(network.calls).toHaveLength(1);
  });

  it('with Jev consented: shows the external preview, sends nothing before 送信して作る, collapses weak candidates', async () => {
    const consent = 'jev|api.typesafe.ai|jev-latest';
    const { plugin } = open({ ai: ai({ providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY, consent } } }) });
    network.respond = (request) => (request.url.includes('typesafe')
      ? jev(JSON.parse(request.body).state.includes('Question: 呼吸') ? 0.1 : 0.95) : chat(CARDS));
    await extract(plugin);
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain('送信前の確認（外部に送ります）');
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain('api.typesafe.ai');
    expect(section().textContent).not.toContain(KEY);
    expect(network.calls).toEqual([]);
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(network.calls.map((call) => new URL(call.url).host)).toEqual(['localhost:11434', 'api.typesafe.ai', 'api.typesafe.ai']);
    expect(network.calls[1].headers.Authorization).toBe(`Bearer ${KEY}`);
    const weak = section().querySelector('details.kioku-ai-weak');
    expect(weak.querySelector('summary').textContent).toBe('AI が根拠が弱いと判定（1 件）');
    expect(weak.querySelector('.kioku-ai-badge').textContent).toBe('根拠が弱い');
    expect(weak.querySelector('.kioku-candidate-adopt')).not.toBeNull();
    expect(generated()[0].querySelector('.kioku-ai-badge').textContent).toBe('推奨');
    expect(document.body.textContent).not.toContain(KEY);
    // Neither the generator nor the judge receives the note name or its path (Q7).
    for (const call of network.calls) {
      expect(call.body).not.toContain('生物');
      expect(call.body).not.toContain('学習/');
    }
  });

  it('sends once when the run button is clicked twice quickly', async () => {
    const { plugin } = open({ ai: ai({ judge: 'none' }) });
    network.respond = () => chat({ cards: [] });
    await extract(plugin);
    const run = section().querySelector('.kioku-ai-run');
    run.click(); run.click();
    await flush();
    expect(network.calls).toHaveLength(1);
  });

  it('re-confirms before sending when the note changed after the preview (E2)', async () => {
    const consent = 'jev|api.typesafe.ai|jev-latest';
    const { plugin, editor } = open({ ai: ai({ providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY, consent } } }) });
    network.respond = (request) => (request.url.includes('typesafe') ? jev(0.95) : chat({ cards: [] }));
    await extract(plugin);
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain(`本文 ${NOTE.trimEnd().length} 字`);
    editor.text = `${NOTE}追記した一文。\n`;
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(network.calls).toEqual([]);
    expect(section().querySelector('.kioku-ai-status').textContent).toContain('ノートか設定が変わったため、送信内容を更新しました');
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain(`本文 ${(NOTE + '追記した一文。').length} 字`);
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(network.calls.map((call) => new URL(call.url).host)).toEqual(['localhost:11434']);
    expect(network.calls[0].body).toContain('追記した一文。');
  });

  it('asks again before sending when consent is missing for an external generator', async () => {
    const { plugin } = open({ ai: ai({ providers: { local: { model: 'gpt-oss:20b-cloud' } } }) });
    await extract(plugin);
    expect(section().querySelector('.kioku-ai-guidance').textContent).toContain('外部送信に同意していません');
    expect(section().querySelector('.kioku-ai-run')).toBeNull();
    expect(network.calls).toEqual([]);
  });

  it('cancels a hung generation, then waits for the abandoned request before sending again', async () => {
    const { plugin } = open({ ai: ai({ judge: 'none' }) });
    const pending = [];
    network.respond = () => new Promise((resolve) => pending.push(resolve));
    await extract(plugin);
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(section().querySelector('.kioku-ai-status').textContent).toMatch(/^生成中…（\d+ 秒）$/);
    section().querySelector('.kioku-ai-cancel').click(); await flush();
    expect(section().querySelector('.kioku-ai-status').textContent).toContain('キャンセルしました');
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(section().querySelector('.kioku-ai-status').textContent).toContain('前の要求の完了を待っています');
    expect(network.calls).toHaveLength(1);
    // Seven minutes later the abandoned request settles: the new one is sent and the notice switches
    // to the generation counter (from the real send) before its result arrives.
    await vi.advanceTimersByTimeAsync(400000);
    pending[0](chat({ cards: [] })); await flush();
    expect(network.calls).toHaveLength(2);
    expect(section().querySelector('.kioku-ai-status').textContent).toBe('生成中…（0 秒）');
    // The counter runs from that send, not from the click ~400 s earlier.
    await vi.advanceTimersByTimeAsync(5000);
    expect(section().querySelector('.kioku-ai-status').textContent).toBe('生成中…（5 秒）');
    pending[1](chat({ cards: [] })); await flush();
    expect(section().querySelector('.kioku-ai-status').textContent).toContain('根拠を引用で示せる候補はありませんでした');
    document.querySelector('.kioku-candidate-close').click();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps counting from the first send across a 429 retry (as the timeout budget does)', async () => {
    const { plugin } = open({ ai: ai({ judge: 'none' }) });
    const pending = [];
    network.respond = () => (network.calls.length === 1
      ? { status: 429, headers: { 'Retry-After': '2' }, text: '' } : new Promise((resolve) => pending.push(resolve)));
    await extract(plugin);
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(section().querySelector('.kioku-ai-status').textContent).toBe('生成中…（0 秒）');
    await vi.advanceTimersByTimeAsync(2000);
    expect(network.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(section().querySelector('.kioku-ai-status').textContent).toBe('生成中…（3 秒）');
    pending[0](chat({ cards: [] })); await flush();
    document.querySelector('.kioku-candidate-close').click();
  });

  it('reports an unreachable local server without writing anything', async () => {
    const { plugin, editor } = open({ ai: ai({ judge: 'none' }) });
    await extract(plugin);
    section().querySelector('.kioku-ai-run').click(); await settle();
    expect(section().querySelector('.kioku-ai-status').textContent)
      .toBe('http://localhost:11434 に接続できません。Ollama などのサーバーが起動しているか確認してください。');
    expect(editor.transactions).toEqual([]);
  });
});

describe('AI settings tab', () => {
  const tab = (plugin) => { const settingTab = plugin.settingTabs[0]; document.body.append(settingTab.containerEl); settingTab.display(); return settingTab; };
  const field = (name) => [...document.querySelectorAll('.setting-item')].find((item) => item.querySelector('.setting-item-name').textContent === name);

  it('is off by default, shows the privacy text, and enabling it never sends anything', async () => {
    const { plugin } = open(null);
    tab(plugin); await flush();
    expect(document.querySelector('.kioku-ai-privacy').textContent).toContain('ノート名・ファイルパス・Vault 名は送りません');
    const toggle = field('AI を使う').querySelector('input');
    expect(toggle.checked).toBe(false);
    expect(field('判定')).toBeUndefined();
    toggle.checked = true; toggle.dispatchEvent(new window.Event('change')); await flush();
    expect(plugin.data.ai).toMatchObject({ enabled: true, judge: 'jev' });
    expect(field('判定').querySelector('select').value).toBe('jev');
    expect(network.calls).toEqual([]);
  });

  it('never puts a saved key into the page, and consent follows the destination', async () => {
    const { plugin } = open({ ai: ai({ providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY } } }) });
    tab(plugin); await flush();
    const keyInput = field('Jev：API キー').querySelector('input');
    expect(keyInput.type).toBe('password');
    expect(keyInput.value).toBe('');
    expect(keyInput.placeholder).toBe('保存済み …TKEY');
    expect(document.body.innerHTML).not.toContain(KEY);
    const consent = field('外部への送信に同意する（api.typesafe.ai）').querySelector('input');
    consent.checked = true; consent.dispatchEvent(new window.Event('change')); await flush();
    expect(plugin.data.ai.providers.jev.consent).toBe('jev|api.typesafe.ai|jev-latest');
    const model = field('生成：モデル名').querySelector('input');
    model.value = 'gpt-oss:20b-cloud'; model.dispatchEvent(new window.Event('input')); model.dispatchEvent(new window.Event('change')); await flush();
    const cloudConsent = field('外部への送信に同意する（localhost:11434）');
    expect(cloudConsent.querySelector('.setting-item-description').textContent).toContain('cloud モデル');
    expect(cloudConsent.querySelector('input').checked).toBe(false);
    // The Jev key and consent were kept while another AI field changed.
    expect(plugin.data.ai.providers.jev).toMatchObject({ apiKey: KEY, consent: 'jev|api.typesafe.ai|jev-latest' });
    expect(network.calls).toEqual([]);
  });

  it('turning consent off for a cloud model clears the stored consent in data.json', async () => {
    const model = 'gemma4:31b-cloud';
    const consent = `local|ollama|http://localhost:11434|${model}`;
    const { plugin } = open({ ai: ai({ providers: { local: { model, consent } } }) });
    tab(plugin); await flush();
    const toggle = field('外部への送信に同意する（localhost:11434）').querySelector('input');
    expect(toggle.checked).toBe(true);
    toggle.checked = false; toggle.dispatchEvent(new window.Event('change')); await flush();
    expect(plugin.data.ai.providers.local.consent).toBeNull();
    expect(field('外部への送信に同意する（localhost:11434）').querySelector('input').checked).toBe(false);
    // And the popup then refuses to send.
    await extract(plugin);
    expect(section().querySelector('.kioku-ai-guidance').textContent).toContain('外部送信に同意していません');
    expect(network.calls).toEqual([]);
  });

  it('refuses a base URL with a path and explains why, keeping the saved one', async () => {
    const { plugin } = open({ ai: ai() });
    tab(plugin); await flush();
    const url = field('生成：接続先').querySelector('input');
    url.value = 'http://localhost:11434/v1'; url.dispatchEvent(new window.Event('input')); await flush();
    expect(field('生成：接続先').querySelector('.kioku-settings-status').textContent).toContain('/v1 などのパスは付けません');
    expect(plugin.saved).toEqual([]);
  });

  const typeInto = async (name, value, { blur = false } = {}) => {
    const input = field(name).querySelector('input');
    input.value = value; input.dispatchEvent(new window.Event('input'));
    if (blur) input.dispatchEvent(new window.Event('change'));
    await flush();
  };

  it('Jev model: saves the trimmed name (empty → jev-latest); a new name needs consent again and is the one sent', async () => {
    const consent = 'jev|api.typesafe.ai|jev-latest';
    const { plugin } = open({ ai: ai({ providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY, consent } } }) });
    network.respond = (request) => (request.url.includes('typesafe') ? jev(0.95) : chat(CARDS));
    tab(plugin); await flush();
    const model = () => field('Jev：モデル名').querySelector('input');
    const jevConsent = () => field('外部への送信に同意する（api.typesafe.ai）').querySelector('input');
    expect(model().value).toBe('jev-latest');
    expect(jevConsent().checked).toBe(true);

    await typeInto('Jev：モデル名', '  jev-2  ', { blur: true });
    expect(plugin.data.ai.providers.jev).toEqual({ apiKey: KEY, model: 'jev-2', consent });
    expect(model().value).toBe('jev-2');
    expect(jevConsent().checked).toBe(false);
    await extract(plugin);
    expect(section().querySelector('.kioku-ai-preview').textContent).toContain('判定：なし（Jev への送信に未同意）');
    document.querySelector('.kioku-candidate-close').click();

    await typeInto('Jev：モデル名', '', { blur: true });
    expect(plugin.data.ai.providers.jev.model).toBe('jev-latest');
    expect(model().value).toBe('jev-latest');
    expect(jevConsent().checked).toBe(true);

    await typeInto('Jev：モデル名', 'jev-2', { blur: true });
    const toggle = jevConsent();
    toggle.checked = true; toggle.dispatchEvent(new window.Event('change')); await flush();
    expect(plugin.data.ai.providers.jev.consent).toBe('jev|api.typesafe.ai|jev-2');
    expect(network.calls).toEqual([]);
    await extract(plugin);
    section().querySelector('.kioku-ai-run').click(); await flush();
    expect(network.calls.map((call) => new URL(call.url).host)).toEqual(['localhost:11434', 'api.typesafe.ai', 'api.typesafe.ai']);
    expect(network.calls.slice(1).map((call) => JSON.parse(call.body).model)).toEqual(['jev-2', 'jev-2']);
  });

  it('timeouts: show the saved seconds, save in-range whole seconds over the latest settings, ignore 0, negatives and empty', async () => {
    const consent = 'jev|api.typesafe.ai|jev-latest';
    const { plugin } = open({ ai: ai({ providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY, consent } },
      timeouts: { generateSeconds: 90, judgeSeconds: 30 } }) });
    tab(plugin); await flush();
    const generate = field('タイムアウト：生成').querySelector('input');
    expect([generate.type, generate.min, generate.value]).toEqual(['number', '1', '90']);
    expect(field('タイムアウト：判定').querySelector('input').value).toBe('30');

    // Alternating fields without a redraw: each save must start from the latest timeouts, not the drawn ones.
    await typeInto('タイムアウト：生成', '300');
    expect(plugin.data.ai.timeouts).toEqual({ generateSeconds: 300, judgeSeconds: 30 });
    await typeInto('タイムアウト：判定', '45');
    expect(plugin.data.ai.timeouts).toEqual({ generateSeconds: 300, judgeSeconds: 45 });
    await typeInto('タイムアウト：生成', '120');
    expect(plugin.data.ai.timeouts).toEqual({ generateSeconds: 120, judgeSeconds: 45 });
    expect(plugin.data.ai.providers.local.model).toBe('qwen3:8b');
    expect(plugin.data.ai.providers.jev).toEqual({ apiKey: KEY, model: 'jev-latest', consent });

    const saves = plugin.saved.length;
    for (const value of ['0', '-5', '']) {
      await typeInto('タイムアウト：生成', value);
      await typeInto('タイムアウト：判定', value);
    }
    expect(plugin.saved).toHaveLength(saves);
    expect(plugin.data.ai.timeouts).toEqual({ generateSeconds: 120, judgeSeconds: 45 });
    expect(network.calls).toEqual([]);
  });

  it('the generation timeout saved here is the one a run waits for', async () => {
    const { plugin } = open({ ai: ai() });
    network.respond = () => new Promise(() => {});
    tab(plugin); await flush();
    await typeInto('タイムアウト：生成', '5');
    expect(plugin.data.ai.timeouts).toEqual({ generateSeconds: 5, judgeSeconds: 20 });
    await extract(plugin);
    section().querySelector('.kioku-ai-run').click(); await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(section().querySelector('.kioku-ai-status').textContent).toBe('生成中…（4 秒）');
    await vi.advanceTimersByTimeAsync(1000);
    expect(section().querySelector('.kioku-ai-status').textContent).toBe('時間内に応答がありませんでした（Ollama（qwen3:8b）、5 秒）。');
  });

  it('the judge timeout saved here is the one each Jev call waits for', async () => {
    const consent = 'jev|api.typesafe.ai|jev-latest';
    const { plugin } = open({ ai: ai({ providers: { local: { model: 'qwen3:8b' }, jev: { apiKey: KEY, consent } } }) });
    network.respond = (request) => (request.url.includes('typesafe') ? new Promise(() => {}) : chat(CARDS));
    tab(plugin); await flush();
    await typeInto('タイムアウト：判定', '3');
    expect(plugin.data.ai.timeouts).toEqual({ generateSeconds: 60, judgeSeconds: 3 });
    await extract(plugin);
    section().querySelector('.kioku-ai-run').click(); await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(section().querySelector('.kioku-ai-judge-failure')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(generated().map((item) => item.querySelector('.kioku-ai-badge').textContent)).toEqual(['未判定（タイムアウト）', '未判定（タイムアウト）']);
    expect(section().querySelector('.kioku-ai-judge-failure').textContent).toBe('時間内に応答がありませんでした（Jev、3 秒）。');
  });
});
