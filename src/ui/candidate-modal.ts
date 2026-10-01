import { Modal, Notice, type App } from 'obsidian';
import { normalizeField, type RecordedCandidate } from '../cards/adoption';
import type { Candidate, CardText } from '../cards/parser';
import type { AdoptResult } from '../cards/writer';

export interface CandidateModalOptions {
  readonly noteName: string;
  readonly scope: 'note' | 'selection';
  readonly candidates: readonly Candidate[];
  /** Writes one adoption. Only the adopt button calls it. */
  readonly adopt: (recorded: RecordedCandidate, edited: CardText) => Promise<AdoptResult>;
  readonly onClosed?: () => void;
}

const STATUS_LABEL: Record<Candidate['status'], string> = {
  new: '未採用',
  adopted: '採用済み',
  'duplicate-id': 'ID 重複のため採用不可',
  'foreign-block-id': '既存の block ID があるため採用不可',
};

interface Entry {
  readonly candidate: Candidate;
  /** Recorded offset, shifted after earlier adoptions in this popup. */
  start: number;
  state: 'open' | 'saving' | 'adopted' | 'discarded';
  cardId: string | null;
  /** The text in the edit fields; survives re-rendering and failed writes. */
  draft: CardText;
  /** The card as adopted in this popup or as recorded in the note. */
  card: CardText;
  message: string;
}

/** Centered popup: original text, editable Q/A, adopt / discard per candidate. */
export class CandidateModal extends Modal {
  private readonly entries: Entry[];
  private shown = false;

  constructor(app: App, private readonly options: CandidateModalOptions) {
    super(app);
    this.entries = options.candidates.map((candidate) => {
      const card = candidate.edit ?? { question: candidate.question, answer: candidate.answer };
      return { candidate, start: candidate.start, state: candidate.status === 'new' ? 'open' : 'adopted',
        cardId: candidate.cardId, draft: { question: candidate.question, answer: candidate.answer }, card, message: '' };
    });
  }

  override onOpen(): void {
    this.shown = true;
    this.modalEl.addClass('kioku-candidate-modal');
    this.setTitle(`Q/A 候補 — ${this.options.noteName}`);
    this.render();
  }

  override onClose(): void {
    this.shown = false;
    this.contentEl.empty();
    this.options.onClosed?.();
  }

  private render(): void {
    if (!this.shown) return;
    const { contentEl } = this;
    contentEl.empty();
    const scope = this.options.scope === 'selection' ? '選択範囲' : 'ノート全体';
    const pending = this.entries.filter((entry) => entry.state === 'open').length;
    contentEl.createEl('p', { cls: 'kioku-candidate-summary',
      text: `${scope}の明示 Q/A：${this.entries.length} 件（未採用 ${pending} 件）。採用したものだけ元ノートに ID を追記します。破棄・閉じるでは何も書き込みません。` });
    if (!this.entries.length) {
      contentEl.createEl('p', { cls: 'kioku-candidate-empty',
        text: '明示 Q/A が見つかりませんでした。行頭の「Q:」または「問:」と、「A:」または「答:」で書いたブロックが対象です。コードブロック・コメント（%%）・Excalidraw の描画データは対象外です。' });
    }
    const list = contentEl.createDiv({ cls: 'kioku-candidate-list' });
    for (const entry of this.entries) {
      if (entry.state !== 'discarded') this.renderEntry(list, entry);
    }
    const footer = contentEl.createDiv({ cls: 'kioku-candidate-footer' });
    const close = footer.createEl('button', { text: '閉じる', cls: 'kioku-candidate-close' });
    close.addEventListener('click', () => this.close());
  }

  private renderEntry(list: HTMLElement, entry: Entry): void {
    const { candidate } = entry;
    const item = list.createDiv({ cls: 'kioku-candidate' });
    item.dataset.kiokuLine = String(candidate.line + 1);
    const status = entry.state === 'adopted' && candidate.status === 'new' ? '採用済み' : STATUS_LABEL[candidate.status];
    item.createDiv({ cls: 'kioku-candidate-meta', text: `${candidate.line + 1} 行目 · ${status}${entry.cardId ? ` · ${entry.cardId}` : ''}` });
    if (candidate.sameAsAdopted && entry.state === 'open') {
      item.createDiv({ cls: 'kioku-candidate-warning', text: '採用済みカードと同じ内容です。' });
    }
    item.createDiv({ cls: 'kioku-candidate-label', text: '原文' });
    item.createEl('pre', { cls: 'kioku-candidate-source', text: candidate.sourceText });
    if (entry.state === 'adopted') {
      item.createDiv({ cls: 'kioku-candidate-label', text: 'カード' });
      item.createEl('pre', { cls: 'kioku-candidate-card', text: `Q: ${entry.card.question}\nA: ${entry.card.answer}` });
      return;
    }
    if (candidate.status !== 'new') return;
    this.field(item, '問い', entry.draft.question, 'kioku-candidate-question', (value) => {
      entry.draft = { ...entry.draft, question: value };
    });
    this.field(item, '答え', entry.draft.answer, 'kioku-candidate-answer', (value) => {
      entry.draft = { ...entry.draft, answer: value };
    });
    item.createDiv({ cls: 'kioku-candidate-message', text: entry.message });
    const actions = item.createDiv({ cls: 'kioku-candidate-actions' });
    const adopt = actions.createEl('button', { text: '採用', cls: 'mod-cta kioku-candidate-adopt' });
    const discard = actions.createEl('button', { text: '破棄', cls: 'kioku-candidate-discard' });
    adopt.disabled = entry.state === 'saving';
    discard.disabled = entry.state === 'saving';
    discard.addEventListener('click', () => {
      if (entry.state !== 'open') return;
      entry.state = 'discarded';
      this.render();
    });
    adopt.addEventListener('click', () => {
      void this.adopt(entry);
    });
  }

  private field(parent: HTMLElement, label: string, value: string, cls: string, update: (value: string) => void): void {
    const wrapper = parent.createEl('label', { cls: 'kioku-candidate-field' });
    wrapper.createSpan({ text: label });
    const area = wrapper.createEl('textarea', { cls });
    area.value = value;
    area.rows = Math.min(6, Math.max(2, value.split('\n').length));
    area.addEventListener('input', () => update(area.value));
  }

  private async adopt(entry: Entry): Promise<void> {
    if (entry.state !== 'open') return;
    entry.state = 'saving';
    entry.message = '保存しています…';
    this.render();
    const edited = entry.draft;
    let result: AdoptResult;
    try {
      result = await this.options.adopt({ start: entry.start, sourceText: entry.candidate.sourceText }, edited);
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) {
      entry.state = 'open';
      entry.message = `保存しませんでした：${result.reason}`;
      new Notice(`Kioku：保存しませんでした。${result.reason}`);
      this.render();
      return;
    }
    entry.state = 'adopted';
    entry.cardId = result.cardId;
    entry.card = { question: normalizeField(edited.question), answer: normalizeField(edited.answer) };
    entry.message = '';
    // Later candidates moved by the inserted text; keep their recorded offsets exact.
    for (const other of this.entries) {
      if (other !== entry && other.start > result.offset) other.start += result.inserted;
    }
    new Notice(`Kioku：採用しました（${result.cardId}）。`);
    this.render();
  }
}
