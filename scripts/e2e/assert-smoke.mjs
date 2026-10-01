export function assertNativeTarget(state, expectedVault) {
  if (!state || state.version === '' || typeof state.version !== 'string' || state.vault !== expectedVault) {
    throw new Error('Not the native Obsidian page for the dedicated test-vault.');
  }
}

export function assertStartup(state, expected) {
  if (!state || state.count !== 1 || state.buildId !== expected.buildId || state.version !== expected.version
      || !state.text.includes('Kioku') || !state.text.includes('未実装') || !state.text.includes('M0')) {
    throw new Error('Actual Kioku M0 modal absent, duplicated, or stale.');
  }
  const { x, y, width, height, viewportWidth, viewportHeight } = state;
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > viewportWidth + 2 || y + height > viewportHeight + 2
      || Math.abs(x + width / 2 - viewportWidth / 2) > 32
      || Math.abs(y + height / 2 - viewportHeight / 2) > 32) {
    throw new Error('Startup modal is not visibly centered in the Obsidian viewport.');
  }
}
