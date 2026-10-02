/**
 * ts-fsrs 5.4.2 assigns four deprecated helpers to the global `Date.prototype` when its module is
 * evaluated (`scheduler`, `diff`, `format`, `dueFormat`). Kioku runs inside Obsidian's shared
 * window, so these would leak into every other plugin. ts-fsrs itself never calls them.
 *
 * This module must be imported before `ts-fsrs` (ES module evaluation follows import order): it
 * records the original descriptors, and `restoreDatePrototype()` puts them back afterwards.
 */
const PATCHED = ['scheduler', 'diff', 'format', 'dueFormat'] as const;

const original = PATCHED.map((name) => [name, Object.getOwnPropertyDescriptor(Date.prototype, name)] as const);

export function restoreDatePrototype(): void {
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(Date.prototype, name, descriptor);
    else Reflect.deleteProperty(Date.prototype, name);
  }
}
