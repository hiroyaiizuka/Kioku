export const nativeTargetExpression = `JSON.stringify({
  vault: window.app?.vault?.adapter?.getBasePath?.() ?? '',
  url: location.href,
  processType: window.process?.type ?? '',
  electron: window.process?.versions?.electron ?? ''
})`;

export function obsidianVersionFromTitle(title) {
  return /Obsidian (\d+\.\d+\.\d+)$/u.exec(title)?.[1] ?? '';
}

export function assertNativeTarget(state, expectedVault) {
  if (!state || !/^\d+\.\d+\.\d+$/u.test(state.version) || state.vault !== expectedVault
      || state.url !== 'app://obsidian.md/index.html' || state.processType !== 'renderer'
      || !/^\d+\.\d+\.\d+$/u.test(state.electron)) {
    throw new Error('Not the native Obsidian page for the dedicated test-vault.');
  }
}

export function assertStartup(state, expected) {
  if (!state || state.count !== 1 || state.buildId !== expected.buildId || state.version !== expected.version
      || !state.text.includes('Kioku') || !state.text.includes('未実装') || !state.text.includes('デッキ')) {
    throw new Error('Actual Kioku status modal absent, duplicated, stale, or not stating what is unimplemented.');
  }
  const { x, y, width, height, viewportWidth, viewportHeight } = state;
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > viewportWidth + 2 || y + height > viewportHeight + 2
      || Math.abs(x + width / 2 - viewportWidth / 2) > 32
      || Math.abs(y + height / 2 - viewportHeight / 2) > 32) {
    throw new Error('Startup modal is not visibly centered in the Obsidian viewport.');
  }
}

/** Every open modal container; Kioku's own modal is recognised only by its scoped class. */
export const modalInventoryExpression = `JSON.stringify([...document.querySelectorAll('.modal-container')].map((container) => ({
  kioku: Boolean(container.querySelector('.kioku-startup-modal')),
  classes: [...(container.querySelector('.modal')?.classList ?? [])].join(' ')
})))`;

export function assertNoForeignModal(modals) {
  if (!Array.isArray(modals)) throw new Error('Could not inspect open Obsidian modals.');
  const foreign = modals.filter((modal) => !modal || modal.kioku !== true);
  if (foreign.length) {
    const names = foreign.map((modal) => modal?.classes || '(unknown)').join(', ');
    throw new Error(`Unexpected foreign modal open (e.g. trust / restricted-mode dialog): ${names}`);
  }
}
