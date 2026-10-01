import { MarkdownView, type App, type TFile } from 'obsidian';
import { planAdoption, type RecordedCandidate } from './adoption';
import type { CardText } from './parser';

export type AdoptResult =
  | { readonly ok: true; readonly cardId: string; readonly offset: number; readonly inserted: number;
    readonly via: 'editor' | 'vault' }
  | { readonly ok: false; readonly reason: string };

/**
 * The MarkdownView showing `file`, preferring one in Source/Live Preview mode.
 * Several views of one file share Obsidian's document sync, so one editor write suffices.
 */
export function findMarkdownView(app: App, file: TFile): MarkdownView | null {
  const views = app.workspace.getLeavesOfType('markdown')
    .map((leaf) => leaf.view)
    .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path);
  return views.find((view) => view.getMode() === 'source') ?? views[0] ?? null;
}

/** Current text of a note: the open editor buffer (including unsaved edits) or the file. */
export async function readNote(app: App, file: TFile): Promise<string> {
  const view = findMarkdownView(app, file);
  return view ? view.editor.getValue() : app.vault.read(file);
}

/**
 * Adopts one candidate. Called only from the adopt button. The original text is verified
 * immediately before the write; on mismatch nothing is written.
 */
export async function adoptCandidate(app: App, file: TFile, recorded: RecordedCandidate,
  edited: CardText): Promise<AdoptResult> {
  const view = findMarkdownView(app, file);
  if (view) {
    const editor = view.editor;
    const plan = planAdoption(editor.getValue(), recorded, edited);
    if (!plan.ok) return plan;
    const at = editor.offsetToPos(plan.offset);
    // One transaction = one Undo step; other views of the same note are synced by Obsidian.
    editor.transaction({ changes: [{ from: at, to: at, text: plan.insert }] });
    return { ok: true, cardId: plan.cardId, offset: plan.offset, inserted: plan.insert.length, via: 'editor' };
  }
  let result: AdoptResult = { ok: false, reason: 'ノートを書き換えられませんでした。' };
  await app.vault.process(file, (data) => {
    const plan = planAdoption(data, recorded, edited);
    if (!plan.ok) {
      result = plan;
      return data;
    }
    result = { ok: true, cardId: plan.cardId, offset: plan.offset, inserted: plan.insert.length, via: 'vault' };
    return plan.next;
  });
  return result;
}
