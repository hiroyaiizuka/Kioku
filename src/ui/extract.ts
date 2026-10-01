import { MarkdownView, Notice, type App, type Modal, type TFile } from 'obsidian';
import { extractCandidates, type Range } from '../cards/parser';
import { adoptCandidate, readNote } from '../cards/writer';
import { CandidateModal } from './candidate-modal';

/** Lets the plugin close popups on unload without owning their contents. */
export interface ModalTracker {
  add(modal: Modal): void;
  delete(modal: Modal): void;
}

function openModal(app: App, file: TFile, text: string, range: Range | undefined, tracker: ModalTracker): void {
  const selection = range !== undefined && range.from !== range.to;
  const modal: CandidateModal = new CandidateModal(app, {
    noteName: file.basename,
    scope: selection ? 'selection' : 'note',
    candidates: extractCandidates(text, selection ? range : undefined),
    adopt: (recorded, edited) => adoptCandidate(app, file, recorded, edited),
    onClosed: () => tracker.delete(modal),
  });
  tracker.add(modal);
  modal.open();
}

/** True when the active leaf is a Markdown note (used by the command's check callback). */
export function hasActiveNote(app: App): boolean {
  return Boolean(app.workspace.getActiveViewOfType(MarkdownView)?.file);
}

/** Explicit user action: read the active note (or its selection) and show candidates. */
export function extractFromActiveNote(app: App, tracker: ModalTracker): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file;
  if (!view || !file) {
    new Notice('Kioku：Markdown ノートを開いてから実行してください。');
    return;
  }
  const editor = view.editor;
  const range = { from: editor.posToOffset(editor.getCursor('from')), to: editor.posToOffset(editor.getCursor('to')) };
  openModal(app, file, editor.getValue(), range, tracker);
}

/** Explicit user action from the file menu: the note may be open (Editor) or closed (Vault). */
export async function extractFromFile(app: App, file: TFile, tracker: ModalTracker): Promise<void> {
  openModal(app, file, await readNote(app, file), undefined, tracker);
}
