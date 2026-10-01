// harness:launch CDP steps against a CDP protocol simulation. Never starts Obsidian; never native evidence.
import { afterEach, describe, expect, it } from 'vitest';
import { enableCommunityPlugins, waitForDedicatedPage } from '../../scripts/lib/dedicated-cdp.mjs';
import { evaluated, startCdpServer } from '../helpers/cdp-server.mjs';

const vault = '/kioku/test-vault';
const servers = [];
afterEach(async () => { while (servers.length) await servers.pop().close(); });
const nativePage = (overrides = {}) => ({ vault, url: 'app://obsidian.md/index.html', processType: 'renderer',
  electron: '39.2.1', layoutReady: true, ...overrides });

/** pages: [{ path, title, state }]; every page answers the page probe with its `state`. */
async function pageServer(pages) {
  const server = await startCdpServer(pages, (path, message) => {
    if (message.method !== 'Runtime.evaluate') return undefined;
    return evaluated(pages.find((page) => page.path === path).state);
  });
  servers.push(server); return server;
}
const wait = (port, extra = {}) => waitForDedicatedPage({ port, vault, version: '1.14.3', alive: () => true, timeoutMs: 3000, ...extra });

describe('waitForDedicatedPage (CDP simulation)', () => {
  it('returns the single native test-vault page with the expected asar version', async () => {
    const server = await pageServer([{ path: '/main', title: 'Welcome - test-vault - Obsidian 1.14.3', state: nativePage() },
      { path: '/blank', title: 'DevTools', state: { vault: '', url: 'about:blank' } }]);
    const page = await wait(server.port);
    expect(page.state).toMatchObject({ vault, version: '1.14.3' });
    expect(page.target.webSocketDebuggerUrl).toBe(server.url('/main'));
  });
  it('fails immediately when any page has another vault open', async () => {
    const server = await pageServer([{ path: '/main', title: 'test-vault - Obsidian 1.14.3', state: nativePage() },
      { path: '/other', title: 'Personal - Obsidian 1.14.3', state: nativePage({ vault: '/Users/me/Personal' }) }]);
    await expect(wait(server.port)).rejects.toThrow(/another vault: \/Users\/me\/Personal/);
  });
  it('fails when the running version differs from the copied asar (installer version ran instead)', async () => {
    const server = await pageServer([{ path: '/main', title: 'test-vault - Obsidian 1.6.7', state: nativePage() }]);
    await expect(wait(server.port)).rejects.toThrow(/Running Obsidian 1.6.7, expected asar 1.14.3/);
  });
  it('fails when two pages have test-vault open', async () => {
    const server = await pageServer([{ path: '/a', title: 'test-vault - Obsidian 1.14.3', state: nativePage() },
      { path: '/b', title: 'test-vault - Obsidian 1.14.3', state: nativePage() }]);
    await expect(wait(server.port)).rejects.toThrow(/Expected one test-vault page; found 2/);
  });
  it('fails when the launched process exits, and times out while the layout is not ready', async () => {
    const server = await pageServer([{ path: '/main', title: 'test-vault - Obsidian 1.14.3', state: nativePage({ layoutReady: false }) }]);
    await expect(wait(server.port, { alive: () => false })).rejects.toThrow(/exited before/);
    await expect(wait(server.port, { timeoutMs: 600 })).rejects.toThrow(/Timed out.*blocked by a system dialog.*check the screen/s);
  });
});

/** Simulated Obsidian restricted-mode state on one page; records the order of harness actions. */
async function pluginServer({ enabled = false, choice = null, trust = true, loaded = ['kioku'], configured = ['kioku'],
  lateModal = false } = {}) {
  const sim = { enabled, choice, trust, events: [] };
  const server = await startCdpServer([{ path: '/main', title: 'test-vault - Obsidian 1.14.3' }], (_path, message) => {
    if (message.method === 'Input.dispatchKeyEvent') {
      if (message.params.type === 'keyDown') { sim.events.push('escape'); sim.trust = false; }
      return undefined;
    }
    if (message.method !== 'Runtime.evaluate') return undefined;
    const expression = message.params.expression;
    if (expression.includes('setEnable(true)')) {
      sim.events.push('setEnable'); sim.enabled = true; sim.choice = 'true'; return evaluated(true);
    }
    if (expression.includes('trustModals')) {
      return evaluated({ enabled: sim.enabled, choice: sim.choice, trustModals: sim.trust ? 1 : 0, modals: sim.trust ? 1 : 0 });
    }
    if (expression.includes('enabledPlugins')) {
      return evaluated({ enabled: sim.enabled, loaded: sim.enabled ? loaded : [], configured,
        modals: sim.trust ? [{ kioku: false, classes: 'modal mod-trust-folder' }]
          : lateModal ? [{ kioku: false, classes: 'modal mod-settings' }] : [] });
    }
    throw new Error(`Unexpected expression: ${expression}`);
  });
  servers.push(server);
  return { sim, target: { webSocketDebuggerUrl: server.url('/main') } };
}

describe('enableCommunityPlugins (CDP simulation)', () => {
  it('first launch: calls setEnable(true) and only then closes the trust dialog with Escape', async () => {
    const { sim, target } = await pluginServer();
    expect(await enableCommunityPlugins({ target })).toMatch(/turned-off-by-harness via app.plugins.setEnable\(true\)/);
    expect(sim.events).toEqual(['setEnable', 'escape']);
  });
  it('relaunch with the stored choice: touches nothing', async () => {
    const { sim, target } = await pluginServer({ enabled: true, choice: 'true', trust: false });
    expect(await enableCommunityPlugins({ target })).toMatch(/already-off/);
    expect(sim.events).toEqual([]);
  });
  it('a stored restricted choice without dialog: setEnable only, no Escape', async () => {
    const { sim, target } = await pluginServer({ choice: 'false', trust: false });
    await enableCommunityPlugins({ target });
    expect(sim.events).toEqual(['setEnable']);
  });
  it('fails when a foreign modal is still open at final verification', async () => {
    const { target } = await pluginServer({ enabled: true, choice: 'true', trust: false, lateModal: true });
    await expect(enableCommunityPlugins({ target, verifyTimeoutMs: 300 })).rejects.toThrow(/Unexpected foreign modal open.*mod-settings/);
  });
  for (const [label, plugins] of [['loaded', { loaded: ['kioku', 'other'] }], ['configured', { configured: ['kioku', 'other'] }]]) {
    it(`fails when a non-Kioku plugin is ${label}`, async () => {
      const { target } = await pluginServer(plugins);
      await expect(enableCommunityPlugins({ target, verifyTimeoutMs: 300 })).rejects.toThrow(/not in the expected state.*other/);
    });
  }
});
