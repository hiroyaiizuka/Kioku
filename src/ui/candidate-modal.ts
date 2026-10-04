import { Modal, Notice, type App } from 'obsidian';
import { normalizeField, serializeCard, type RecordedCandidate } from '../cards/adoption';
import type { RecordedAnchor } from '../cards/insertion';
import { PENDING_CLOSED_NOTICE, REASONS, lostInline, lostNotice, refusalInline, refusalNotice } from '../cards/reasons';
import type { Candidate, CardText } from '../cards/parser';
import { errorMessage, type AdoptResult, type Confirmation } from '../cards/writer';
import { contentWarnings, type CheckedCandidate } from '../ai/checks';
import { VERDICT_ORDER, type Judgement } from '../ai/classify';
import type { GenerationResult, Preparation, RunCallbacks, RunContext } from '../ai/pipeline';
import { AI_GUIDANCE } from '../ai/reasons';

type ReadyPreparation = Preparation & { readonly ok: true };

/** The AI part of the popup. Nothing here touches the network until the run button is pressed. */
export interface CandidateAi {
  /** Loads settings and builds the text to send from `text` (no network). Rejects when data.json is unreadable. */
  prepare(text: string): Promise<Preparation>;
  /** The note's current text (explicit action, at the run click). */
  readNote(): Promise<string>;
  run(prep: ReadyPreparation, context: RunContext, callbacks: RunCallbacks, signal: AbortSignal): Promise<void>;
}

export interface CandidateModalOptions {
  readonly noteName: string;
  readonly scope: 'note' | 'selection';
  /** The note text the candidates were extracted from. */
  readonly text: string;
  readonly candidates: readonly Candidate[];
  /** Writes one adoption. Only the adopt button calls it. */
  readonly adopt: (recorded: RecordedCandidate, edited: CardText) => Promise<AdoptResult>;
  /** Inserts one generated card after its quote's block. Only the adopt button calls it. */
  readonly adoptGenerated: (recorded: RecordedAnchor, edited: CardText) => Promise<AdoptResult>;
  /** Waits until the adopted ID is confirmed on disk; aborted when the popup closes. */
  readonly confirm: (cardId: string, signal: AbortSignal) => Promise<Confirmation>;
  /**
   * The one recovery attempt after a lost write: waits until the note is quiet, then runs `again`
   * (the same write, which re-verifies the original). `null` = not quiet in time, or the popup closed.
   */
  readonly recover: (previous: AdoptResult & { readonly ok: true }, again: () => Promise<AdoptResult>,
    signal: AbortSignal) => Promise<AdoptResult | null>;
  readonly ai: CandidateAi;
  readonly onClosed?: () => void;
}

const STATUS_LABEL: Record<Candidate['status'], string> = {
  new: '未採用',
  adopted: '採用済み',
  'duplicate-id': 'ID 重複のため採用不可',
  'foreign-block-id': '既存の block ID があるため採用不可',
};

interface Generated {
  readonly item: CheckedCandidate;
  /** 1-based line of the quote in the note the run used. */
  readonly line: number;
  readonly generator: string;
  readonly judge: string | null;
  /** null while the judge is still working. */
  judgement: Judgement | null;
}

interface Entry {
  /** Exactly one of `candidate` (explicit Q/A in the note) and `generated` (AI) is set. */
  readonly candidate: Candidate | null;
  readonly generated: Generated | null;
  /** Recorded offset (block start / quote anchor start), shifted after earlier adoptions in this popup. */
  start: number;
  /** `blocked`: duplicate Kioku ID or a foreign block ID; shown but never adoptable. */
  /** `confirming`: written, waiting for the ID to be confirmed on disk before showing success. */
  state: 'open' | 'saving' | 'confirming' | 'adopted' | 'discarded' | 'blocked';
  cardId: string | null;
  /** The text in the edit fields; survives re-rendering and failed writes. */
  draft: CardText;
  /** The card as adopted in this popup or as recorded in the note. */
  card: CardText;
  message: string;
  /** Stable key for restoring focus across re-renders. */
  readonly key: string;
}

type AiPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly prep: ReadyPreparation; readonly notice: string }
  /** The run button was pressed: settings and the note are being re-read; nothing is sent yet. */
  | { readonly kind: 'preparing'; readonly prep: ReadyPreparation }
  /**
   * `startedAt`: when this run's generation request was first actually sent (after any wait for a
   * slot). Retries (429 / 503) do not reset it, matching the timeout budget, which also runs from
   * the first send. `sent`: that first send happened.
   */
  | { readonly kind: 'running'; readonly prep: ReadyPreparation; startedAt: number; sent: boolean; waiting: boolean; generated: boolean }
  | { readonly kind: 'finished'; readonly prep: ReadyPreparation; readonly message: string };

/** Centered popup: original text, editable Q/A, adopt / discard per candidate; AI candidates on request. */
export class CandidateModal extends Modal {
  private readonly entries: Entry[];
  private shown = false;
  private silent = false;
  private readonly lifetime = new AbortController();
  private ai: AiPhase = { kind: 'loading' };
  private run: AbortController | null = null;
  private runId = 0;
  private runSummary = '';
  private judgeFailure: string | null = null;
  private ticker: number | null = null;
  private statusEl: HTMLElement | null = null;
  private nextKey = 0;

  constructor(app: App, private readonly options: CandidateModalOptions) {
    super(app);
    this.entries = options.candidates.map((candidate) => {
      const card = candidate.edit ?? { question: candidate.question, answer: candidate.answer };
      const state: Entry['state'] = candidate.status === 'new' ? 'open'
        : candidate.status === 'adopted' ? 'adopted' : 'blocked';
      return { candidate, generated: null, start: candidate.start, state, key: this.key(),
        cardId: candidate.cardId, draft: { question: candidate.question, answer: candidate.answer }, card, message: '' };
    });
  }

  override onOpen(): void {
    this.shown = true;
    this.modalEl.addClass('kioku-candidate-modal');
    this.setTitle(`問い・答えの候補 — ${this.options.noteName}`);
    this.render();
    void this.loadAi();
  }

  /**
   * Closes without the pending-confirmation Notice. Used on plugin unload (disable / app quit),
   * where a Notice would be noisy or never seen.
   */
  closeSilently(): void {
    this.silent = true;
    this.close();
  }

  override onClose(): void {
    // A write may already be on disk but unconfirmed: say so once instead of staying silent.
    if (!this.silent && this.busy()) {
      new Notice(PENDING_CLOSED_NOTICE);
    }
    this.shown = false;
    this.lifetime.abort();
    this.run?.abort();
    this.stopTicker();
    this.contentEl.empty();
    this.options.onClosed?.();
  }

  private key(): string {
    this.nextKey += 1;
    return String(this.nextKey);
  }

  private async loadAi(): Promise<void> {
    let prep: Preparation;
    try {
      prep = await this.options.ai.prepare(this.options.text);
    } catch (error) {
      prep = { ok: false, kind: 'disabled', reason: `設定を読み込めませんでした（${errorMessage(error)}）。AI で候補を作れません。` };
    }
    if (!this.shown) return;
    this.ai = prep.ok ? { kind: 'ready', prep, notice: '' } : { kind: 'unavailable', reason: prep.reason };
    this.render();
  }

  private render(): void {
    if (!this.shown) return;
    const { contentEl } = this;
    // Keep the reader's place in a long list across re-renders after adopt / discard / judgements.
    const scrollTop = contentEl.querySelector('.kioku-candidate-list')?.scrollTop ?? 0;
    const focus = this.focusState();
    contentEl.empty();
    const explicit = this.entries.filter((entry) => entry.candidate);
    if (!explicit.length) this.renderSyntaxHint(contentEl);
    const list = contentEl.createDiv({ cls: 'kioku-candidate-list' });
    for (const entry of explicit) {
      if (entry.state !== 'discarded') this.renderEntry(list, entry);
    }
    this.renderAi(list);
    list.scrollTop = scrollTop;
    const footer = contentEl.createDiv({ cls: 'kioku-candidate-footer' });
    const close = footer.createEl('button', { text: '閉じる', cls: 'kioku-candidate-close' });
    close.addEventListener('click', () => this.close());
    this.restoreFocus(focus);
  }

  private focusState(): { key: string; cls: string; start: number; end: number } | null {
    const active = this.contentEl.ownerDocument.activeElement;
    // Tag check instead of instanceof: popout windows have their own element constructors.
    if (active?.tagName !== 'TEXTAREA' || !this.contentEl.contains(active)) return null;
    const area = active as HTMLTextAreaElement;
    if (!area.dataset.kiokuKey) return null;
    return { key: area.dataset.kiokuKey, cls: area.className, start: area.selectionStart, end: area.selectionEnd };
  }

  private restoreFocus(focus: ReturnType<CandidateModal['focusState']>): void {
    if (!focus) return;
    const area = Array.from(this.contentEl.querySelectorAll('textarea'))
      .find((element) => element.dataset.kiokuKey === focus.key && element.className === focus.cls);
    if (!area) return;
    area.focus();
    area.setSelectionRange(focus.start, focus.end);
  }

  private renderEntry(list: HTMLElement, entry: Entry): void {
    const { candidate } = entry;
    if (!candidate) return;
    const item = list.createDiv({ cls: 'kioku-candidate' });
    item.dataset.kiokuLine = String(candidate.line + 1);
    const status = entry.state === 'adopted' ? '採用済み' : STATUS_LABEL[candidate.status];
    item.createDiv({ cls: 'kioku-candidate-meta', text: `${candidate.line + 1} 行目 · ${status}${entry.cardId ? ` · ${entry.cardId}` : ''}` });
    if (candidate.sameAsAdopted && entry.state === 'open') {
      item.createDiv({ cls: 'kioku-candidate-warning', text: '採用済みカードと同じ内容です。' });
    }
    if (entry.state === 'open') {
      for (const warning of contentWarnings(candidate)) item.createDiv({ cls: 'kioku-candidate-warning', text: warning });
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
    this.fields(item, entry);
    if (candidate.needsBlankLine) {
      item.createDiv({ cls: 'kioku-candidate-note',
        text: '直後に空行がないため、採用時にこのブロックの後へ空行を1行追加します（ID を段落末に置くため。原文の文字は変えません。改行コードは Obsidian の編集画面の扱いに従います）。' });
    } else if (candidate.followedByText) {
      item.createDiv({ cls: 'kioku-candidate-note',
        text: '編集して採用した場合だけ、編集記録の後に空行を1行追加します（原文の文字は変えません。改行コードは Obsidian の編集画面の扱いに従います）。' });
    }
    this.actions(item, entry);
  }

  private fields(item: HTMLElement, entry: Entry): void {
    this.field(item, '問い', entry.draft.question, 'kioku-candidate-question', entry.key, (value) => {
      entry.draft = { ...entry.draft, question: value };
    });
    this.field(item, '答え', entry.draft.answer, 'kioku-candidate-answer', entry.key, (value) => {
      entry.draft = { ...entry.draft, answer: value };
    });
  }

  private actions(item: HTMLElement, entry: Entry): void {
    item.createDiv({ cls: 'kioku-candidate-message', text: entry.message });
    const actions = item.createDiv({ cls: 'kioku-candidate-actions' });
    const adopt = actions.createEl('button', { text: '残す', cls: 'mod-cta kioku-candidate-adopt' });
    const discard = actions.createEl('button', { text: '見送る', cls: 'kioku-candidate-discard' });
    // One adoption at a time: offsets of other cards are only shifted after a confirmed write.
    adopt.disabled = this.busy();
    discard.disabled = entry.state !== 'open';
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

  private field(parent: HTMLElement, label: string, value: string, cls: string, key: string, update: (value: string) => void): void {
    const wrapper = parent.createEl('label', { cls: 'kioku-candidate-field' });
    wrapper.createSpan({ text: `${label}（編集可能）` });
    const area = wrapper.createEl('textarea', { cls });
    area.dataset.kiokuKey = key;
    area.value = value;
    area.rows = Math.min(6, Math.max(2, value.split('\n').length));
    area.addEventListener('input', () => update(area.value));
  }

  // ---- AI section (docs/m3-design.md §8) ----

  private renderAi(list: HTMLElement): void {
    const section = list.createDiv({ cls: 'kioku-ai-section' });
    section.createEl('h3', { cls: 'kioku-ai-heading', text: 'AI の候補' });
    const phase = this.ai;
    this.statusEl = null;
    if (phase.kind === 'loading') {
      section.createEl('p', { cls: 'kioku-ai-status', text: 'AI の設定を確認しています…' });
      return;
    }
    if (phase.kind === 'unavailable') {
      section.createEl('p', { cls: 'kioku-ai-guidance', text: phase.reason });
      const actions = section.createDiv({ cls: 'kioku-candidate-actions' });
      const recheck = actions.createEl('button', { text: '設定を確認し直す', cls: 'kioku-ai-recheck' });
      recheck.addEventListener('click', () => {
        this.ai = { kind: 'loading' };
        this.render();
        void this.loadAi();
      });
      this.renderGenerated(section);
      return;
    }
    const preview = section.createDiv({ cls: 'kioku-ai-preview' });
    preview.createDiv({ cls: 'kioku-candidate-label', text: phase.prep.external ? '送信前の確認（外部に送ります）' : '送信先' });
    for (const line of phase.prep.preview) preview.createDiv({ cls: 'kioku-ai-preview-line', text: line });
    if (phase.prep.external) {
      preview.createDiv({ cls: 'kioku-candidate-note',
        text: 'キャンセルしても、送信済みの分は送信先で処理・請求されることがあります。' });
    }
    const status = section.createEl('p', { cls: 'kioku-ai-status' });
    this.statusEl = status;
    status.setText(this.statusText());
    if (this.judgeFailure) section.createEl('p', { cls: 'kioku-candidate-warning kioku-ai-judge-failure', text: this.judgeFailure });
    const actions = section.createDiv({ cls: 'kioku-candidate-actions' });
    if (phase.kind === 'running') {
      const cancel = actions.createEl('button', { text: 'キャンセル', cls: 'kioku-ai-cancel' });
      cancel.addEventListener('click', () => this.cancelRun());
    } else {
      const label = phase.prep.external ? '送信して作る' : 'AI で候補を作る';
      const run = actions.createEl('button', { text: label, cls: 'mod-cta kioku-ai-run' });
      run.disabled = phase.kind === 'preparing';
      run.addEventListener('click', () => {
        void this.startRun();
      });
    }
    this.renderGenerated(section);
  }

  private statusText(): string {
    const phase = this.ai;
    if (phase.kind === 'ready') return phase.notice;
    if (phase.kind === 'preparing') return '送信内容を確認しています…';
    if (phase.kind === 'finished') return [phase.message, this.runSummary].filter(Boolean).join(' ');
    if (phase.kind !== 'running') return '';
    if (phase.waiting) return AI_GUIDANCE.waiting;
    const seconds = Math.floor((Date.now() - phase.startedAt) / 1000);
    if (!phase.generated) return `生成中…（${seconds} 秒）`;
    const generated = this.entries.filter((entry) => entry.generated);
    const judged = generated.filter((entry) => entry.generated?.judgement).length;
    return `${this.runSummary} 判定中…（${judged} / ${generated.length} 件、${seconds} 秒）`;
  }

  private renderGenerated(section: HTMLElement): void {
    const visible = this.entries.filter((entry) => entry.generated && entry.state !== 'discarded');
    const rank = (entry: Entry): number => VERDICT_ORDER[entry.generated?.judgement?.verdict ?? 'unjudged'];
    const ordered = visible.map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry);
    const weak = ordered.filter((entry) => entry.generated?.judgement?.verdict === 'weak' && entry.state !== 'adopted');
    for (const entry of ordered) {
      if (!weak.includes(entry)) this.renderGeneratedEntry(section, entry);
    }
    if (!weak.length) return;
    // E1: never silently dropped; collapsed at the end and still adoptable when opened.
    const details = section.createEl('details', { cls: 'kioku-ai-weak' });
    details.createEl('summary', { text: `AI が根拠が弱いと判定（${weak.length} 件）` });
    for (const entry of weak) this.renderGeneratedEntry(details, entry);
  }

  private renderGeneratedEntry(parent: HTMLElement, entry: Entry): void {
    const generated = entry.generated;
    if (!generated) return;
    const { item: checked, judgement } = generated;
    const item = parent.createDiv({ cls: 'kioku-candidate kioku-generated' });
    item.dataset.kiokuLine = String(generated.line);
    const badge = entry.state === 'adopted' ? '採用済み' : judgement?.label ?? '判定中…';
    item.dataset.kiokuVerdict = judgement?.verdict ?? 'pending';
    const meta = item.createDiv({ cls: 'kioku-candidate-meta' });
    meta.createSpan({ cls: 'kioku-ai-badge', text: badge });
    meta.createSpan({ text: ` · 引用 ${generated.line} 行目 · 生成：${generated.generator}${generated.judge ? ` · 判定：${generated.judge}` : ''}${entry.cardId ? ` · ${entry.cardId}` : ''}` });
    if (entry.state !== 'adopted') {
      for (const reason of [...checked.warnings, ...(judgement?.reasons ?? [])]) {
        item.createDiv({ cls: 'kioku-candidate-warning', text: reason });
      }
    }
    item.createDiv({ cls: 'kioku-candidate-label', text: '引用（原文のまま）' });
    item.createEl('pre', { cls: 'kioku-candidate-source', text: checked.quote.text });
    if (entry.state === 'adopted') {
      item.createDiv({ cls: 'kioku-candidate-label', text: 'カード' });
      item.createEl('pre', { cls: 'kioku-candidate-card', text: `Q: ${entry.card.question}\nA: ${entry.card.answer}` });
      return;
    }
    if (checked.blocked) {
      item.createDiv({ cls: 'kioku-candidate-blocked', text: checked.blocked });
      const actions = item.createDiv({ cls: 'kioku-candidate-actions' });
      const discard = actions.createEl('button', { text: '見送る', cls: 'kioku-candidate-discard' });
      discard.addEventListener('click', () => {
        entry.state = 'discarded';
        this.render();
      });
      return;
    }
    this.fields(item, entry);
    const anchorLine = this.lineOf(checked.quote.anchor.end);
    const draft = { question: normalizeField(entry.draft.question), answer: normalizeField(entry.draft.answer) };
    item.createDiv({ cls: 'kioku-candidate-note',
      text: `採用すると、引用元のブロック（${anchorLine} 行目まで。箇条書き・表・引用・callout ならその全体）の直後に、空行を挟んで次を追加します。原文の文字は変えません。` });
    item.createEl('pre', { cls: 'kioku-candidate-card kioku-ai-insert-preview', text: insertionPreview(draft, checked.quote.text) });
    this.actions(item, entry);
  }

  private lineOf(offset: number): number {
    const phase = this.ai;
    const text = phase.kind === 'loading' || phase.kind === 'unavailable' ? this.options.text : phase.prep.note;
    return text.slice(0, offset).split(/\r\n|\r|\n/).length;
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = window.setInterval(() => {
      if (this.statusEl) this.statusEl.setText(this.statusText());
    }, 1000);
  }

  private stopTicker(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  private cancelRun(): void {
    this.run?.abort();
  }

  /**
   * The only place that starts network traffic. Settings and the note are read again first: if
   * the destinations or the text to send changed since the preview was shown, the new preview is
   * shown and nothing is sent until the button is pressed again (E2).
   */
  private async startRun(): Promise<void> {
    const phase = this.ai;
    if (phase.kind !== 'ready' && phase.kind !== 'finished') return;
    // Leave ready synchronously (before any await): a second click is ignored, never a second send.
    this.ai = { kind: 'preparing', prep: phase.prep };
    this.render();
    let prep: Preparation;
    try {
      const text = await this.options.ai.readNote();
      if (this.options.scope === 'selection' && text !== this.options.text) {
        prep = { ok: false, kind: 'empty', reason: 'ノートが抽出後に変更されたため、選択範囲を特定できません。もう一度抽出してください。' };
      } else {
        prep = await this.options.ai.prepare(text);
      }
    } catch (error) {
      prep = { ok: false, kind: 'disabled', reason: `ノートか設定を読み込めませんでした（${errorMessage(error)}）。` };
    }
    if (!this.shown) return;
    if (!prep.ok) {
      this.ai = { kind: 'unavailable', reason: prep.reason };
      this.render();
      return;
    }
    const previous = phase.prep;
    const changed = prep.note !== previous.note || JSON.stringify(prep.preview) !== JSON.stringify(previous.preview)
      || prep.external !== previous.external;
    if (changed && prep.external) {
      this.ai = { kind: 'ready', prep, notice: 'ノートか設定が変わったため、送信内容を更新しました。確認してから「送信して作る」を押してください。' };
      this.render();
      return;
    }
    this.execute(prep);
  }

  private execute(prep: ReadyPreparation): void {
    this.runId += 1;
    const runId = this.runId;
    const controller = new AbortController();
    this.run = controller;
    this.lifetime.signal.addEventListener('abort', () => controller.abort(), { once: true });
    // A new run replaces the previous run's candidates that were not adopted.
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.generated && entry.state !== 'adopted' && entry.state !== 'saving' && entry.state !== 'confirming') this.entries.splice(index, 1);
    }
    this.runSummary = '';
    this.judgeFailure = null;
    const running: AiPhase & { kind: 'running' } = { kind: 'running', prep, startedAt: Date.now(), sent: false, waiting: false, generated: false };
    this.ai = running;
    this.render();
    this.startTicker();
    const current = (): boolean => this.shown && this.runId === runId;
    const generatedEntries: Entry[] = [];
    const callbacks: RunCallbacks = {
      onSending: (stage) => {
        if (!current()) return;
        // The slot was acquired: leave the waiting notice; the generation counter starts at the first real send.
        const wasWaiting = running.waiting;
        running.waiting = false;
        const firstSend = stage === 'generation' && !running.sent;
        if (firstSend) {
          running.sent = true;
          running.startedAt = Date.now();
        }
        if (wasWaiting || firstSend) this.render();
      },
      onWaiting: () => {
        if (!current()) return;
        running.waiting = true;
        this.render();
      },
      onGenerated: (result) => {
        if (!current()) return;
        running.waiting = false;
        running.generated = true;
        this.acceptGeneration(prep, result, generatedEntries);
        this.render();
      },
      onJudged: (index, judgement, failure) => {
        if (!current()) return;
        running.waiting = false;
        const entry = generatedEntries[index];
        if (entry?.generated) entry.generated.judgement = judgement;
        if (failure && !this.judgeFailure) this.judgeFailure = failure;
        this.render();
      },
    };
    const context = this.runContext();
    void this.options.ai.run(prep, context, callbacks, controller.signal)
      .catch((error: unknown) => {
        if (current() && !running.generated) this.acceptGeneration(prep, { ok: false, message: `AI の処理に失敗しました（${errorMessage(error)}）。`, cancelled: false }, generatedEntries);
      })
      .finally(() => {
        if (!current()) return;
        this.stopTicker();
        this.run = null;
        const cancelled = controller.signal.aborted;
        if (this.ai.kind === 'running') {
          this.ai = { kind: 'finished', prep, message: cancelled ? 'キャンセルしました。届いた候補は残しています。' : '完了しました。' };
        }
        this.render();
      });
  }

  private acceptGeneration(prep: ReadyPreparation, result: GenerationResult, into: Entry[]): void {
    if (!result.ok) {
      this.stopTicker();
      this.ai = { kind: 'finished', prep, message: result.message };
      return;
    }
    const { report } = result;
    const parts = [`AI の候補 ${report.candidates.length} 件`];
    if (report.quoteMismatch) parts.push(`原文に見つからない引用のため除外 ${report.quoteMismatch} 件`);
    if (report.empty) parts.push(`問いか答えが空のため除外 ${report.empty} 件`);
    if (report.sameAsAdopted) parts.push(`採用済みと同じため非表示 ${report.sameAsAdopted} 件`);
    if (report.duplicates) parts.push(`重複のため非表示 ${report.duplicates} 件`);
    if (report.overCap) parts.push(`上限 20 件を超えた分 ${report.overCap} 件`);
    if (result.malformed) parts.push(`形式が不正な応答 ${result.malformed} 件`);
    this.runSummary = `${parts.join('、')}。`;
    if (!report.candidates.length) this.runSummary += ' 根拠を引用で示せる候補はありませんでした。';
    const judge = prep.judge?.label ?? null;
    for (const item of report.candidates) {
      const entry: Entry = { candidate: null, generated: { item, line: this.lineOf(item.quote.start), generator: prep.generator.label, judge, judgement: null },
        start: item.quote.anchor.start, state: 'open', cardId: null, draft: item.card, card: item.card, message: '', key: this.key() };
      into.push(entry);
      this.entries.push(entry);
    }
  }

  /** Cards in the note and explicit candidates, for the generated-candidate duplicate checks. */
  private runContext(): RunContext {
    const explicit: CardText[] = [];
    const adopted: CardText[] = [];
    for (const entry of this.entries) {
      if (entry.state === 'adopted') adopted.push(entry.card);
      else if (entry.candidate && entry.state !== 'blocked') explicit.push({ question: entry.candidate.question, answer: entry.candidate.answer });
    }
    return { explicit, adopted };
  }

  // ---- adoption (explicit and generated share the M1 write path) ----

  private busy(): boolean {
    return this.entries.some((entry) => entry.state === 'saving' || entry.state === 'confirming');
  }

  private fail(entry: Entry, message: string, notice: string): void {
    entry.state = 'open';
    entry.message = message;
    new Notice(notice);
    this.render();
  }

  private writer(entry: Entry, edited: CardText): () => Promise<AdoptResult> {
    const { candidate, generated } = entry;
    if (candidate) {
      const recorded = { start: entry.start, sourceText: candidate.sourceText };
      return () => this.options.adopt(recorded, edited);
    }
    const quote = generated?.item.quote;
    const recorded: RecordedAnchor = { start: entry.start, text: quote?.anchor.text ?? '', quote: quote?.text ?? '' };
    return () => this.options.adoptGenerated(recorded, edited);
  }

  private async adopt(entry: Entry): Promise<void> {
    if (entry.state !== 'open' || this.busy()) return;
    entry.state = 'saving';
    entry.message = '保存しています…';
    this.render();
    const edited = entry.draft;
    const write = this.writer(entry, edited);
    const { signal } = this.lifetime;
    let result: AdoptResult;
    try {
      result = await write();
    } catch (error) {
      result = { ok: false, reason: errorMessage(error) };
    }
    // At most one recovery: a second loss means another view keeps saving over the note.
    for (let attempt = 0; ; attempt += 1) {
      if (!result.ok) {
        this.fail(entry, refusalInline(result.reason), refusalNotice(result.reason));
        return;
      }
      entry.state = 'confirming';
      entry.message = '保存を確認しています…';
      this.render();
      let confirmation: Confirmation;
      try {
        confirmation = await this.options.confirm(result.cardId, signal);
      } catch {
        confirmation = 'lost';
      }
      if (confirmation === 'cancelled') return;
      if (confirmation === 'confirmed') break;
      if (attempt >= 1) {
        this.fail(entry, lostInline(REASONS.lostAfterWrite), lostNotice(REASONS.lostAfterWrite));
        return;
      }
      entry.message = '別の画面の保存と重なりました。ノートが落ち着くのを待って、もう一度保存します…';
      this.render();
      let retried: AdoptResult | null;
      try {
        retried = await this.options.recover(result, write, signal);
      } catch (error) {
        retried = { ok: false, reason: errorMessage(error) };
      }
      if (signal.aborted) return;
      if (!retried) {
        this.fail(entry, lostInline(REASONS.lostAfterWrite), lostNotice(REASONS.lostAfterWrite));
        return;
      }
      result = retried;
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

/** The lines a generated card adds, with placeholder IDs (shown before adoption). */
export const insertionPreview = (card: CardText, quote: string): string =>
  `${serializeCard(card, '\n')} ^kioku-…\n\n%%kioku-src:kioku-…\n${quote}\n%%`;
