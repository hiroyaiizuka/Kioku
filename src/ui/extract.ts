import { MarkdownView, Notice, type App, type Modal, type TFile } from 'obsidian';
import { prepareRun, runPipeline, type AiRuntime } from '../ai/pipeline';
import { extractCandidates, type Range } from '../cards/parser';
import { adoptCandidate, adoptGenerated, confirmAdoption, errorMessage, readNote, recoverAdoption } from '../cards/writer';
import type { KiokuSettings } from '../review/types';
import { CandidateModal, type CandidateAi } from './candidate-modal';

/** Lets the plugin close popups on unload without owning their contents. */
export interface ModalTracker {
  add(modal: Modal): void;
  delete(modal: Modal): void;
}

/** What the popup needs for AI candidates: the long-lived runtime and lazily loaded settings. */
export interface AiAccess {
  readonly runtime: AiRuntime;
  readonly settings: () => Promise<KiokuSettings>;
}

function candidateAi(app: App, file: TFile, extracted: string, range: Range | undefined, access: AiAccess): CandidateAi {
  return {
    // The selection applies only to the text it was made in (the popup refuses a changed note then).
    prepare: async (text) => prepareRun(access.runtime, (await access.settings()).ai, text, text === extracted ? range : undefined),
    readNote: () => readNote(app, file),
    run: runPipeline,
  };
}

function openModal(app: App, file: TFile, text: string, range: Range | undefined, tracker: ModalTracker, access: AiAccess): void {
  const selection = range !== undefined && range.from !== range.to;
  const modal: CandidateModal = new CandidateModal(app, {
    noteName: file.basename,
    scope: selection ? 'selection' : 'note',
    text,
    candidates: extractCandidates(text, selection ? range : undefined),
    adopt: (recorded, edited) => adoptCandidate(app, file, recorded, edited),
    adoptGenerated: (recorded, edited) => adoptGenerated(app, file, recorded, edited),
    confirm: (cardId, signal) => confirmAdoption(app, file, cardId, signal),
    recover: (previous, again, signal) => recoverAdoption(app, file, previous, again, signal),
    ai: candidateAi(app, file, text, selection ? range : undefined, access),
    onClosed: () => tracker.delete(modal),
  });
  tracker.add(modal);
  modal.open();
}

/** True when the active leaf is a Markdown note (used by the command's check callback). */
export function hasActiveNote(app: App): boolean {
  return Boolean(app.workspace.getActiveViewOfType(MarkdownView)?.file);
}

/**
 * Explicit user action: read the active note (or its selection) and show candidates.
 * In Reading view there is no editable selection and the hidden editor is not authoritative,
 * so the whole note is read from an editing view or the file instead.
 */
export function extractFromActiveNote(app: App, tracker: ModalTracker, access: AiAccess): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file;
  if (!view || !file) {
    new Notice('Kioku：Markdown ノートを開いてから実行してください。');
    return;
  }
  if (view.getMode() !== 'source') {
    void extractFromFile(app, file, tracker, access);
    return;
  }
  const editor = view.editor;
  const range = { from: editor.posToOffset(editor.getCursor('from')), to: editor.posToOffset(editor.getCursor('to')) };
  openModal(app, file, editor.getValue(), range, tracker, access);
}

/** Explicit user action from the file menu: the note may be open (Editor) or closed (Vault). */
export async function extractFromFile(app: App, file: TFile, tracker: ModalTracker, access: AiAccess): Promise<void> {
  let text: string;
  try {
    text = await readNote(app, file);
  } catch (error) {
    new Notice(`Kioku：ノートを読めませんでした（${errorMessage(error)}）。`);
    return;
  }
  openModal(app, file, text, undefined, tracker, access);
}
