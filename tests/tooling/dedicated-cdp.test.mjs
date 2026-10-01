// harness:launch CDP steps against a CDP protocol simulation that EVALUATES the real expression text (node:vm) on a
// fake Obsidian page, so expression shape bugs (e.g. double JSON encoding) fail here. Never starts Obsidian.
import { afterEach, describe, expect, it } from 'vitest';
import { enableCommunityPlugins, waitForDedicatedPage } from '../../scripts/lib/dedicated-cdp.mjs';
import { evaluateInPage, fakeDocument, fakePage, startCdpServer } from '../helpers/cdp-server.mjs';

const vault = '/kioku/test-vault';
const servers = [];
afterEach(async () => { while (servers.length) await servers.pop().close(); });

/** Fake renderer page globals from a compact description. */
function pageGlobals({ vault: path = vault, url = 'app://obsidian.md/index.html', layoutReady = true, electron = '39.2.1' } = {}) {
  return {
    app: { vault: { adapter: { getBasePath: () => path } }, workspace: { layoutReady } },
    location: { href: url }, process: { type: 'renderer', versions: { electron } }, document: fakeDocument([]),
  };
}

async function serve(pages, onMessage = () => undefined) {
  const server = await startCdpServer(pages, async (path, message) => {
    const page = pages.find((item) => item.path === path);
    const handled = onMessage(page, message);
    if (handled !== undefined) return handled;
    if (message.method === 'Runtime.evaluate') return evaluateInPage(page.context, message.params.expression);
    return undefined;
  });
  servers.push(server); return server;
}
const page = (path, title, description) => ({ path, title, context: fakePage(pageGlobals(description)) });
const wait = (port, extra = {}) => waitForDedicatedPage({ port, vault, version: '1.14.3', alive: () => true, timeoutMs: 3000, ...extra });

describe('waitForDedicatedPage (evaluating CDP simulation)', () => {
  it('returns the single native test-vault page with the expected asar version', async () => {
    const server = await serve([page('/main', 'Welcome - test-vault - Obsidian 1.14.3'),
      page('/blank', 'DevTools', { vault: '', url: 'about:blank' })]);
    const found = await wait(server.port);
    expect(found.state).toMatchObject({ vault, version: '1.14.3', layoutReady: true, processType: 'renderer' });
    expect(found.target.webSocketDebuggerUrl).toBe(server.url('/main'));
  });
  it('fails immediately when any page has another vault open', async () => {
    const server = await serve([page('/main', 'test-vault - Obsidian 1.14.3'),
      page('/other', 'Personal - Obsidian 1.14.3', { vault: '/Users/me/Personal' })]);
    await expect(wait(server.port)).rejects.toThrow(/another vault: \/Users\/me\/Personal/);
  });
  it('fails when the running version differs from the copied asar (installer version ran instead)', async () => {
    const server = await serve([page('/main', 'test-vault - Obsidian 1.6.7')]);
    await expect(wait(server.port)).rejects.toThrow(/Running Obsidian 1.6.7, expected asar 1.14.3/);
  });
  it('fails when two pages have test-vault open', async () => {
    const server = await serve([page('/a', 'test-vault - Obsidian 1.14.3'), page('/b', 'test-vault - Obsidian 1.14.3')]);
    await expect(wait(server.port)).rejects.toThrow(/Expected one test-vault page; found 2/);
  });
  it('fails when the launched process exits, and times out while the layout is not ready', async () => {
    const server = await serve([page('/main', 'test-vault - Obsidian 1.14.3', { layoutReady: false })]);
    await expect(wait(server.port, { alive: () => false })).rejects.toThrow(/exited before/);
    await expect(wait(server.port, { timeoutMs: 600 })).rejects.toThrow(/Timed out.*blocked by a system dialog.*check the screen/s);
  });
});

/**
 * Fake Obsidian restricted-mode page. `app.plugins` mirrors 1.14.3: isEnabled() reads localStorage
 * 'enable-plugin-<appId>'; setEnable(true) stores 'true' and loads every configured plugin. The trust dialog is a
 * `.modal-container` with `.mod-trust-folder`; Escape closes the top modal.
 */
async function pluginServer({ choice = null, trust = true, loaded = ['kioku'], configured = ['kioku'], lateModal = false } = {}) {
  const events = []; const storage = new Map(); if (choice !== null) storage.set('enable-plugin-abc', choice);
  const containers = trust ? [['modal', 'mod-lg', 'mod-trust-folder']] : [];
  const loadedPlugins = {};
  const enabledNow = () => storage.get('enable-plugin-abc') === 'true';
  if (enabledNow()) for (const id of loaded) loadedPlugins[id] = {};
  let verified = false;
  const plugins = {
    enabledPlugins: new Set(configured),
    get plugins() {
      // The verification phase reads app.plugins.plugins; a modal opening here appears only after the decision.
      if (lateModal && !verified) { verified = true; containers.push(['modal', 'mod-settings']); }
      return loadedPlugins;
    },
    isEnabled: () => enabledNow(),
    setEnable: async (value) => {
      events.push('setEnable'); storage.set('enable-plugin-abc', value ? 'true' : 'false');
      if (value) for (const id of loaded) loadedPlugins[id] = {};
    },
  };
  const context = fakePage({ ...pageGlobals(), document: fakeDocument(containers),
    app: { ...pageGlobals().app, appId: 'abc', plugins },
    localStorage: { getItem: (key) => storage.get(key) ?? null } });
  const server = await serve([{ path: '/main', title: 'test-vault - Obsidian 1.14.3', context }], (_page, message) => {
    if (message.method === 'Input.dispatchKeyEvent') {
      if (message.params.type === 'keyDown') { events.push('escape'); containers.pop(); }
      return {};
    }
    return undefined;
  });
  return { events, target: { webSocketDebuggerUrl: server.url('/main') } };
}

describe('enableCommunityPlugins (evaluating CDP simulation)', () => {
  it('first launch: calls setEnable(true) and only then closes the trust dialog with Escape', async () => {
    const { events, target } = await pluginServer();
    expect(await enableCommunityPlugins({ target })).toMatch(/turned-off-by-harness via app.plugins.setEnable\(true\)/);
    expect(events).toEqual(['setEnable', 'escape']);
  });
  it('regression: the verification gets a real modal ARRAY (not a JSON string) on an already-enabled relaunch', async () => {
    // Natively failed with "Could not inspect open Obsidian modals." when the inventory was double-encoded.
    const { events, target } = await pluginServer({ choice: 'true', trust: false });
    expect(await enableCommunityPlugins({ target, verifyTimeoutMs: 1000 })).toMatch(/already-off/);
    expect(events).toEqual([]);
  });
  it('a stored restricted choice without dialog: setEnable only, no Escape', async () => {
    const { events, target } = await pluginServer({ choice: 'false', trust: false });
    await enableCommunityPlugins({ target });
    expect(events).toEqual(['setEnable']);
  });
  it('fails when a foreign modal is still open at final verification', async () => {
    const { target } = await pluginServer({ choice: 'true', trust: false, lateModal: true });
    await expect(enableCommunityPlugins({ target, verifyTimeoutMs: 300 })).rejects.toThrow(/Unexpected foreign modal open.*mod-settings/);
  });
  for (const [label, plugins] of [['loaded', { loaded: ['kioku', 'other'], configured: ['kioku', 'other'] }],
    ['configured', { configured: ['kioku', 'other'] }]]) {
    it(`fails when a non-Kioku plugin is ${label}`, async () => {
      const { target } = await pluginServer(plugins);
      await expect(enableCommunityPlugins({ target, verifyTimeoutMs: 300 })).rejects.toThrow(/not in the expected state.*other/);
    });
  }
});
