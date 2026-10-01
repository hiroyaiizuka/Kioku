import { MarkdownView, TFile, type App } from 'obsidian';
import { planAdoption, type RecordedCandidate } from './adoption';
import { extractCandidates, type CardText } from './parser';
import { REASONS, canvasEmbeds, canvasUnreadable, writeFailed } from './reasons';

export type AdoptResult =
  | { readonly ok: true; readonly cardId: string; readonly offset: number; readonly inserted: number;
    readonly via: 'editor' | 'vault' }
  | { readonly ok: false; readonly reason: string };

/**
 * A MarkdownView of `file` that is editing it (Source or Live Preview, `getMode() === 'source'`).
 * A view open only in Reading mode is NOT returned: its hidden editor is not the document Obsidian
 * saves, so a write there would be silently lost. Several editing views of one file share
 * Obsidian's document sync, so one editor write suffices.
 */
export function findEditingView(app: App, file: TFile): MarkdownView | null {
  return app.workspace.getLeavesOfType('markdown')
    .map((leaf) => leaf.view)
    .find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path
      && view.getMode() === 'source') ?? null;
}

/** Current text of a note: an editing view's buffer (including unsaved edits) or the file. */
export async function readNote(app: App, file: TFile): Promise<string> {
  const view = findEditingView(app, file);
  return view ? view.editor.getValue() : app.vault.read(file);
}

/** Message of a thrown value, also for errors from another realm (e.g. a popout window). */
export function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

const UNCONFIRMED = REASONS.unconfirmedWrite;

/**
 * Adopts one candidate. Called only from the adopt button. The original text is verified
 * immediately before the write; on mismatch nothing is written. Success is reported only
 * after the written content is confirmed.
 */
export async function adoptCandidate(app: App, file: TFile, recorded: RecordedCandidate,
  edited: CardText): Promise<AdoptResult> {
  const embedded = await openCanvasEmbedding(app, file);
  if (embedded) return { ok: false, reason: embedded };
  const view = findEditingView(app, file);
  if (view) {
    const editor = view.editor;
    const plan = planAdoption(editor.getValue(), recorded, edited);
    if (!plan.ok) return plan;
    const at = editor.offsetToPos(plan.offset);
    // One transaction = one Undo step; other views of the same note are synced by Obsidian.
    editor.transaction({ changes: [{ from: at, to: at, text: plan.insert }] });
    if (view.getMode() !== 'source' || editor.getValue() !== plan.next) return { ok: false, reason: UNCONFIRMED };
    return { ok: true, cardId: plan.cardId, offset: plan.offset, inserted: plan.insert.length, via: 'editor' };
  }
  // Closed, or open only in Reading view: write the file; Obsidian re-renders open views on modify.
  let result: AdoptResult = { ok: false, reason: UNCONFIRMED };
  let expected: string | null = null;
  let written: string;
  try {
    written = await app.vault.process(file, (data) => {
      const plan = planAdoption(data, recorded, edited);
      if (!plan.ok) {
        result = plan;
        return data;
      }
      expected = plan.next;
      result = { ok: true, cardId: plan.cardId, offset: plan.offset, inserted: plan.insert.length, via: 'vault' };
      return plan.next;
    });
  } catch (error) {
    return { ok: false, reason: writeFailed(errorMessage(error)) };
  }
  if (result.ok && written !== expected) return { ok: false, reason: UNCONFIRMED };
  return result;
}

interface CanvasNode {
  readonly type?: unknown;
  readonly file?: unknown;
}

/**
 * A reason to refuse when an open Canvas embeds `file`. A Canvas file node can hold its own
 * editor for the note and later save a stale buffer over our write (observed in Obsidian 1.14.3,
 * also without Kioku). Only open `canvas` leaves are detectable through the public API; hover
 * popovers and other plugins' views are not, which is what `confirmAdoption` guards against.
 */
export async function openCanvasEmbedding(app: App, file: TFile): Promise<string | null> {
  for (const leaf of app.workspace.getLeavesOfType('canvas')) {
    const canvasFile = (leaf.view as { file?: unknown }).file;
    if (!(canvasFile instanceof TFile)) continue;
    let nodes: unknown;
    try {
      nodes = (JSON.parse(await app.vault.cachedRead(canvasFile)) as { nodes?: unknown }).nodes;
    } catch (error) {
      return canvasUnreadable(canvasFile.path, errorMessage(error));
    }
    if (Array.isArray(nodes) && nodes.some((node: CanvasNode) => node.type === 'file' && node.file === file.path)) {
      return canvasEmbeds(canvasFile.path);
    }
  }
  return null;
}

export type Confirmation = 'confirmed' | 'lost' | 'cancelled';

export interface ConfirmTiming {
  readonly intervalMs: number;
  readonly settleMs: number;
  readonly deadlineMs: number;
}

export const CONFIRM_TIMING: ConfirmTiming = { intervalMs: 250, settleMs: 3000, deadlineMs: 6000 };

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function idOnDisk(app: App, file: TFile, cardId: string): Promise<boolean> {
  try {
    return extractCandidates(await app.vault.read(file))
      .some((candidate) => candidate.cardId === cardId && candidate.status === 'adopted');
  } catch {
    return false;
  }
}

/**
 * Confirms that the adopted card's ID is on disk at an adopted block and is still there after
 * `settleMs` (another editor, e.g. a Canvas node or hover popover, may save a stale buffer a moment
 * after our write). Flushes the editing view first so the editor path need not wait for Obsidian's
 * save debounce. Polls the file until `deadlineMs`; returns `cancelled` when `signal` aborts.
 */
export async function confirmAdoption(app: App, file: TFile, cardId: string, signal: AbortSignal,
  timing: ConfirmTiming = CONFIRM_TIMING): Promise<Confirmation> {
  const view = findEditingView(app, file);
  if (view) await view.save().catch(() => undefined); // A failed flush shows up as a missing ID.
  for (let elapsed = 0; ; elapsed += timing.intervalMs) {
    if (signal.aborted) return 'cancelled';
    const present = await idOnDisk(app, file, cardId);
    if (signal.aborted) return 'cancelled';
    if (present && elapsed >= timing.settleMs) return 'confirmed';
    if (elapsed >= timing.deadlineMs) return 'lost';
    if (!(await sleep(timing.intervalMs, signal))) return 'cancelled';
  }
}
