import { MarkdownView, type App, type TFile } from 'obsidian';
import { planAdoption, type RecordedCandidate } from './adoption';
import type { CardText } from './parser';

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

const UNCONFIRMED = '書き込みを確認できませんでした。ノートを開いて ID が付いたか確認してください。';

/**
 * Adopts one candidate. Called only from the adopt button. The original text is verified
 * immediately before the write; on mismatch nothing is written. Success is reported only
 * after the written content is confirmed.
 */
export async function adoptCandidate(app: App, file: TFile, recorded: RecordedCandidate,
  edited: CardText): Promise<AdoptResult> {
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
    return { ok: false, reason: `ノートを書き換えられませんでした（${errorMessage(error)}）。` };
  }
  if (result.ok && written !== expected) return { ok: false, reason: UNCONFIRMED };
  return result;
}
