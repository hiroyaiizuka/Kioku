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

function assertCentered(state, what) {
  const { x, y, width, height, viewportWidth, viewportHeight } = state;
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > viewportWidth + 2 || y + height > viewportHeight + 2
      || Math.abs(x + width / 2 - viewportWidth / 2) > 32
      || Math.abs(y + height / 2 - viewportHeight / 2) > 32) {
    throw new Error(`${what} is not visibly centered in the Obsidian viewport.`);
  }
}

/** Status modal (command / deck picker button): current build, honest about what is unimplemented. */
export function assertStartup(state, expected) {
  if (!state || state.count !== 1 || state.buildId !== expected.buildId || state.version !== expected.version
      || !state.text.includes('Kioku') || !state.text.includes('未実装') || !state.text.includes('デッキ')) {
    throw new Error('Actual Kioku status modal absent, duplicated, stale, or not stating what is unimplemented.');
  }
  assertCentered(state, 'Status modal');
}

/** Ribbon target since M2: the deck picker, whose root carries the build identity. */
export function assertDeckPicker(state, expected) {
  if (!state || state.count !== 1 || state.buildId !== expected.buildId || state.version !== expected.version
      || !state.text.includes('Kioku') || !state.text.includes('全デッキ') || state.loaded !== true) {
    throw new Error('Actual Kioku deck picker absent, duplicated, stale or not loaded.');
  }
  assertCentered(state, 'Deck picker');
}

/** Observes one modal root; the identity is on the root itself or on `identitySelector` inside it. */
export function modalObservation(selector, identitySelector) {
  const identity = identitySelector ? `e?.querySelector(${JSON.stringify(identitySelector)})` : 'e';
  return `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(selector)});`
    + `const b=${identity};const r=e?.getBoundingClientRect();`
    + `return {count:document.querySelectorAll(${JSON.stringify(selector)}).length,text:e?.textContent??'',`
    + `loaded:Boolean(e?.querySelector('.kioku-deck-list, .kioku-deck-problem')),`
    + `buildId:b?.dataset.kiokuBuildId,version:b?.dataset.kiokuVersion,x:r?.x??0,y:r?.y??0,width:r?.width??0,height:r?.height??0,`
    + `viewportWidth:innerWidth,viewportHeight:innerHeight}})())`;
}
