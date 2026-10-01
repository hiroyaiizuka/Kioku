import { Modal, Notice, type App } from 'obsidian';
import { normalizeField, type RecordedCandidate } from '../cards/adoption';
import type { Candidate, CardText } from '../cards/parser';
import { errorMessage, type AdoptResult } from '../cards/writer';

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
  /** `blocked`: duplicate Kioku ID or a foreign block ID; shown but never adoptable. */
  state: 'open' | 'saving' | 'adopted' | 'discarded' | 'blocked';
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
      const state: Entry['state'] = candidate.status === 'new' ? 'open'
        : candidate.status === 'adopted' ? 'adopted' : 'blocked';
      return { candidate, start: candidate.start, state,
        cardId: candidate.cardId, draft: { question: candidate.question, answer: candidate.answer }, card, message: '' };
    });
  }

  override onOpen(): void {
    this.shown = true;
    this.modalEl.addClass('kioku-candidate-modal');
    this.setTitle(`問い・答えの候補 — ${this.options.noteName}`);
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
    // Keep the reader's place in a long list across re-renders after adopt / discard.
    const scrollTop = contentEl.querySelector('.kioku-candidate-list')?.scrollTop ?? 0;
    contentEl.empty();
    const scope = this.options.scope === 'selection' ? '選択範囲' : 'ノート全体';
    const pending = this.entries.filter((entry) => entry.state === 'open').length;
    contentEl.createEl('p', { cls: 'kioku-candidate-summary',
      text: `${scope}の明示した問い・答え：${this.entries.length} 件（未採用 ${pending} 件）。採用したものだけ元ノートに ID を追記します。破棄・閉じるでは何も書き込みません。` });
    if (!this.entries.length) this.renderSyntaxHint(contentEl);
    const list = contentEl.createDiv({ cls: 'kioku-candidate-list' });
    for (const entry of this.entries) {
      if (entry.state !== 'discarded') this.renderEntry(list, entry);
    }
    list.scrollTop = scrollTop;
    const footer = contentEl.createDiv({ cls: 'kioku-candidate-footer' });
    const close = footer.createEl('button', { text: '閉じる', cls: 'kioku-candidate-close' });
    close.addEventListener('click', () => this.close());
  }

  private renderEntry(list: HTMLElement, entry: Entry): void {
    const { candidate } = entry;
    const item = list.createDiv({ cls: 'kioku-candidate' });
    item.dataset.kiokuLine = String(candidate.line + 1);
    const status = entry.state === 'adopted' ? '採用済み' : STATUS_LABEL[candidate.status];
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
    if (entry.state === 'blocked') {
      item.createDiv({ cls: 'kioku-candidate-blocked',
        text: candidate.status === 'duplicate-id'
          ? '同じ Kioku ID が複数のブロックにあります。どちらかの ID を消してから再抽出してください。'
          : 'このブロックには既に別の block ID があり、Kioku の ID を追記できません。' });
      return;
    }
    this.field(item, '問い', entry.draft.question, 'kioku-candidate-question', (value) => {
      entry.draft = { ...entry.draft, question: value };
    });
    this.field(item, '答え', entry.draft.answer, 'kioku-candidate-answer', (value) => {
      entry.draft = { ...entry.draft, answer: value };
    });
    if (candidate.needsBlankLine) {
      item.createDiv({ cls: 'kioku-candidate-note',
        text: '直後に空行がないため、採用時にこのブロックの後へ空行を1行追加します（ID を段落末に置くため。原文の文字は変えません。改行コードは Obsidian の編集画面の扱いに従います）。' });
    } else if (candidate.followedByText) {
      item.createDiv({ cls: 'kioku-candidate-note',
        text: '編集して採用した場合だけ、編集記録の後に空行を1行追加します（原文の文字は変えません。改行コードは Obsidian の編集画面の扱いに従います）。' });
    }
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

  private renderSyntaxHint(parent: HTMLElement): void {
    const hint = parent.createEl('p', { cls: 'kioku-candidate-empty' });
    hint.createSpan({ text: '明示した問い・答えが見つかりませんでした。対象は、行頭に' });
    hint.createEl('code', { text: 'Q:' });
    hint.createSpan({ text: '（または「問:」）と' });
    hint.createEl('code', { text: 'A:' });
    hint.createSpan({ text: '（または「答:」）を書いたブロックです。コードブロック・コメント・数式・Excalidraw の描画データは対象外です。' });
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
      result = { ok: false, reason: errorMessage(error) };
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
