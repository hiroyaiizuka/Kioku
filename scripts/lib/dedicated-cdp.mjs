// CDP steps of harness:launch for the dedicated instance (loopback only). Unit tests replace these with fakes.
import { assertNativeTarget, assertNoForeignModal, modalInventoryExpression, nativeTargetExpression,
  obsidianVersionFromTitle } from '../e2e/assert-smoke.mjs';
import { CDP, sleep } from './cdp.mjs';

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}.`);
  return response.json();
}

async function probe(url, expression) {
  const client = new CDP(url, 5000);
  try { await client.connect(); return await client.value(expression); }
  finally { client.close(); }
}

const pageExpression = `JSON.stringify({ ...JSON.parse(${nativeTargetExpression}),
  layoutReady: Boolean(window.app?.workspace?.layoutReady) })`;

/** Wait until exactly one native page has test-vault open (and no page has any other vault). */
export async function waitForDedicatedPage({ port, vault, version, alive, timeoutMs = 90000 }) {
  const end = Date.now() + timeoutMs;
  let last = 'no CDP response yet';
  while (Date.now() < end) {
    if (!alive()) throw new Error('Dedicated Obsidian exited before its test-vault page appeared.');
    try {
      const pages = (await targets(port)).filter((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
      const observed = [];
      for (const target of pages) {
        const state = await probe(target.webSocketDebuggerUrl, pageExpression).catch(() => null);
        observed.push({ target, state: state && { ...state, version: obsidianVersionFromTitle(target.title ?? '') } });
      }
      const foreign = observed.filter(({ state }) => state?.vault && state.vault !== vault);
      if (foreign.length) throw Object.assign(new Error(`A page opened another vault: ${foreign[0].state.vault}`), { fatal: true });
      const matches = observed.filter(({ state }) => state?.vault === vault && state.url === 'app://obsidian.md/index.html');
      last = `${matches.length} test-vault page(s) among ${pages.length} page(s)`;
      if (matches.length === 1 && matches[0].state.layoutReady && matches[0].state.version) {
        assertNativeTarget(matches[0].state, vault);
        if (matches[0].state.version !== version) {
          throw Object.assign(new Error(`Running Obsidian ${matches[0].state.version}, expected asar ${version}.`), { fatal: true });
        }
        return matches[0];
      }
      if (matches.length > 1) throw Object.assign(new Error(`Expected one test-vault page; found ${matches.length}.`), { fatal: true });
    } catch (error) {
      if (error.fatal) throw error;
      last = error.message;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for exactly one dedicated test-vault page (${last}).`);
}

const restrictedStateExpression = `JSON.stringify({
  enabled: Boolean(window.app?.plugins?.isEnabled?.()),
  choice: window.app?.appId ? localStorage.getItem('enable-plugin-' + window.app.appId) : null,
  trustModals: document.querySelectorAll('.modal-container .mod-trust-folder').length,
  modals: document.querySelectorAll('.modal-container').length
})`;

/**
 * Decide what to do about Obsidian's restricted mode. Obsidian opens the `.mod-trust-folder` dialog when the vault
 * has community plugins and no per-vault choice exists in localStorage; its "enable" button calls
 * `app.plugins.setEnable(true)`, which is exactly what the harness calls (without opening Settings).
 */
export function restrictedModeAction(state, waitedLongEnough) {
  if (!state) return 'wait';
  if (state.enabled) {
    if (!state.modals) return 'none';
    if (state.trustModals === 1 && state.modals === 1) return 'close-trust';
    throw new Error('Unexpected modal while resolving restricted mode; refusing to click through it.');
  }
  if (state.modals > 0) {
    if (state.trustModals === 1 && state.modals === 1) return 'enable-and-close-trust';
    throw new Error('Unexpected modal while resolving restricted mode; refusing to click through it.');
  }
  if (state.choice === 'false') return 'enable'; // A previous manual "restricted mode" choice in this dedicated profile.
  if (waitedLongEnough) throw new Error('Restricted mode is on but no trust dialog appeared; refusing to guess.');
  return 'wait';
}

/** Turn restricted mode off for the dedicated profile only, then prove only Kioku is loaded and no modal remains. */
export async function enableCommunityPlugins({ target, timeoutMs = 10000, verifyTimeoutMs = 5000 }) {
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const end = Date.now() + timeoutMs;
    let action;
    for (;;) {
      action = restrictedModeAction(await client.value(restrictedStateExpression), Date.now() > end);
      if (action !== 'wait') break;
      await sleep(250);
    }
    if (action === 'enable' || action === 'enable-and-close-trust') {
      await client.value('window.app.plugins.setEnable(true).then(() => JSON.stringify(true))');
    }
    if (action === 'enable-and-close-trust' || action === 'close-trust') {
      await client.pressEscape(); // The dialog's cancel path only closes it; the choice was already stored above.
    }
    const verifyEnd = Date.now() + verifyTimeoutMs;
    let verified;
    while (Date.now() < verifyEnd) {
      verified = await client.value(`JSON.stringify({ enabled: app.plugins.isEnabled(), loaded: Object.keys(app.plugins.plugins).sort(),
        configured: [...app.plugins.enabledPlugins].sort(), modals: ${modalInventoryExpression} })`);
      if (verified.enabled && verified.modals.length === 0 && verified.loaded.join() === 'kioku') break;
      await sleep(100);
    }
    if (!verified?.enabled || verified.loaded.join() !== 'kioku' || verified.configured.join() !== 'kioku') {
      throw new Error(`Community plugins not in the expected state (loaded: ${verified?.loaded}, configured: ${verified?.configured}).`);
    }
    assertNoForeignModal(verified.modals);
    if (action === 'none') return 'already-off (choice stored in this dedicated profile)';
    if (action === 'close-trust') return 'already-off; stray trust dialog closed with Escape';
    return 'turned-off-by-harness via app.plugins.setEnable(true) (dedicated profile only)';
  } finally { client.close(); }
}
