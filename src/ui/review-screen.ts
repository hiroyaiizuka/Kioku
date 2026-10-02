import { Component, MarkdownRenderer, Notice, type App } from 'obsidian';
import { errorMessage } from '../cards/error-message';
import { kiokuDay } from '../review/day';
import { createReviewEvent } from '../review/event';
import { ReviewQueue, newAllowance, type ReviewCard } from '../review/queue';
import { intervalLabel, previewIntervals } from '../review/scheduler';
import { GRADES, type Grade, type KiokuDay, type KiokuSettings, type ReviewEvent } from '../review/types';
import { STORE_REASONS, ratingNotSaved, saveFailed } from '../store/reasons';
import type { ReviewStore } from '../store/review-store';

export interface ReviewContext {
  readonly app: App;
  readonly container: HTMLElement;
  readonly store: ReviewStore;
  readonly settings: KiokuSettings;
  readonly deckLabel: string;
  readonly cards: readonly ReviewCard[];
  readonly today: KiokuDay;
  readonly now: () => Date;
  readonly openNote: (card: ReviewCard) => void;
  readonly backToPicker: () => void;
  readonly close: () => void;
}

const GRADE_LABEL: Record<Grade, string> = { 1: 'もう一度', 2: '難しい', 3: '普通', 4: '簡単' };
const EXTRA_NEW = [10, 20] as const;
const DAY_CHANGED = 'Kioku：日付が変わったため、評価せずにデッキ選択を読み直しました。';

/** `![[…]]` and `![…](…)` embeds are shown as plain links until the answer is revealed (they may show the answer). */
export const hideEmbeds = (markdown: string): string => markdown.replace(/!\[\[/g, '[[').replace(/!\[([^\]\n]*)\]\(/g, '[$1](');

type Phase = 'question' | 'answer' | 'saving' | 'failed' | 'done';
type Action = () => void;

/**
 * Question → reveal → rate (1–4) → next, inside the deck picker modal. Keyboard input arrives
 * through `handleKey` only (one path; native button activation by Space/Enter is suppressed), so a
 * focused button and the shortcut can never both act. Key repeat and IME composition are ignored,
 * and every input is ignored while a rating is being saved.
 */
export class ReviewScreen {
  private readonly queue: ReviewQueue;
  private current: ReviewCard | null = null;
  private phase: Phase = 'question';
  /** Changes on every render; clicks from buttons of an earlier render are ignored. */
  private token = 0;
  private component: Component | null = null;
  private readonly actions = new WeakMap<HTMLElement, Action>();
  private pending: ReviewEvent | null = null;
  private failure = '';
  private closed = false;
  private warnedState = false;

  constructor(private readonly ctx: ReviewContext) {
    this.queue = new ReviewQueue(ctx.cards, (id) => ctx.store.state.cards[id], ctx.today);
  }

  private allowance(): number {
    return newAllowance(this.ctx.store.state.today, this.ctx.today, this.ctx.settings.newPerDay);
  }

  start(): void {
    this.advance();
  }

  /** Stops rendering; a save already in flight still completes (failures are reported once). */
  dispose(): void {
    this.closed = true;
    this.component?.unload();
    this.component = null;
  }

  /** Returns true when the key belongs to the review screen (its default action is then prevented). */
  handleKey(evt: KeyboardEvent): boolean {
    if (this.closed || evt.isComposing || evt.key === 'Process') return false;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return false;
    const action = this.keyAction(evt);
    if (action === undefined) return false;
    evt.preventDefault();
    evt.stopPropagation();
    if (!evt.repeat && action) action();
    return true;
  }

  /** `undefined`: not ours. `null`: ours but nothing to do now (e.g. while saving). */
  private keyAction(evt: KeyboardEvent): Action | null | undefined {
    const key = evt.key;
    const activation = key === ' ' || key === 'Enter';
    if (!activation && !['1', '2', '3', '4', 's', 'S'].includes(key)) return undefined;
    if (this.phase === 'saving') return null;
    if (activation) {
      // Space / Enter act on the focused Kioku button through this single path.
      const focused = evt.target ? this.actions.get(evt.target as HTMLElement) : undefined;
      if (focused) return focused;
      return this.phase === 'question' ? () => this.reveal() : null;
    }
    if (key === 's' || key === 'S') return this.phase === 'question' || this.phase === 'answer' ? () => this.skip() : null;
    if (this.phase !== 'answer') return null;
    const grade = Number(key) as Grade;
    return () => void this.rate(grade);
  }

  private button(parent: HTMLElement, text: string, cls: string, action: Action, disabled = false): HTMLButtonElement {
    const button = parent.createEl('button', { text, cls });
    const token = this.token;
    const run: Action = () => {
      if (!this.closed && token === this.token && !button.disabled) action();
    };
    button.disabled = disabled;
    this.actions.set(button, run);
    button.addEventListener('click', run);
    return button;
  }

  private advance(): void {
    this.current = this.queue.next(this.allowance());
    this.phase = this.current ? 'question' : 'done';
    this.render();
  }

  private reveal(): void {
    if (this.phase !== 'question') return;
    this.phase = 'answer';
    this.render();
  }

  private skip(): void {
    if ((this.phase !== 'question' && this.phase !== 'answer') || !this.current) return;
    // Nothing is written anywhere; the card simply leaves this session's queue.
    this.queue.markSkipped(this.current.id);
    this.advance();
  }

  private async rate(grade: Grade): Promise<void> {
    const card = this.current;
    if (this.phase !== 'answer' || !card || this.ctx.store.readOnly) return;
    const now = this.ctx.now();
    if (kiokuDay(now, this.ctx.settings.dayStartHour) !== this.ctx.today) {
      // The queue, limits and previews belong to the session's day; start over for the new day.
      new Notice(DAY_CHANGED);
      this.ctx.backToPicker();
      return;
    }
    this.phase = 'saving';
    this.failure = '';
    this.render();
    try {
      this.pending = await createReviewEvent({ cardId: card.id, card, before: this.ctx.store.state.cards[card.id] ?? null,
        grade, now, dayStartHour: this.ctx.settings.dayStartHour });
    } catch (error) {
      this.fail(saveFailed(errorMessage(error)));
      return;
    }
    await this.save();
  }

  /** Saves the pending event; a retry reuses the same event (same eventId), never a new rating. */
  private async save(): Promise<void> {
    const event = this.pending;
    const card = this.current;
    if (!event || !card) return;
    this.phase = 'saving';
    this.render();
    let result;
    try {
      result = await this.ctx.store.record(event);
    } catch (error) {
      result = { ok: false as const, reason: saveFailed(errorMessage(error)) };
    }
    if (!result.ok) {
      this.fail(result.reason);
      return;
    }
    this.pending = null;
    this.queue.markRated(card.id);
    if (!result.stateSaved && !this.warnedState) {
      this.warnedState = true;
      new Notice(STORE_REASONS.stateUpdateFailed);
    }
    if (!this.closed) this.advance();
  }

  private fail(reason: string): void {
    if (this.closed) {
      new Notice(`${STORE_REASONS.closedWhileSaving}（${reason}）`);
      return;
    }
    this.phase = 'failed';
    this.failure = ratingNotSaved(reason);
    this.render();
  }

  private async addExtra(count: number): Promise<void> {
    if (this.phase !== 'done') return;
    this.phase = 'saving';
    this.render();
    const saved = await this.ctx.store.addExtraNew(this.ctx.today, count);
    if (!saved) new Notice(STORE_REASONS.stateUpdateFailed);
    if (!this.closed) this.advance();
  }

  private render(): void {
    if (this.closed) return;
    this.token += 1;
    this.component?.unload();
    this.component = new Component();
    this.component.load();
    const root = this.ctx.container;
    root.empty();
    const screen = root.createDiv({ cls: 'kioku-review' });
    screen.dataset.kiokuPhase = this.phase;
    // Keeps keyboard focus inside the modal when no button can take it (e.g. while saving).
    screen.tabIndex = -1;
    const header = screen.createDiv({ cls: 'kioku-review-header' });
    header.createSpan({ cls: 'kioku-review-deck', text: this.ctx.deckLabel });
    header.createSpan({ cls: 'kioku-review-remaining',
      text: `残り ${this.queue.remaining(this.allowance())} 枚` });
    if (this.ctx.store.readOnly) {
      screen.createDiv({ cls: 'kioku-review-readonly', text: '読み取り専用：評価は保存できません（スキップと閲覧だけできます）。' });
    }
    if (this.phase === 'done' || !this.current) {
      this.renderDone(screen);
      return;
    }
    const card = this.current;
    const shown = this.phase !== 'question';
    const question = screen.createDiv({ cls: 'kioku-review-question markdown-rendered' });
    this.renderMarkdown(shown ? card.question : hideEmbeds(card.question), question, card.path);
    if (shown) {
      screen.createEl('hr');
      const answer = screen.createDiv({ cls: 'kioku-review-answer markdown-rendered' });
      this.renderMarkdown(card.answer, answer, card.path);
    }
    const actions = screen.createDiv({ cls: 'kioku-review-actions' });
    let focus: HTMLButtonElement | null = null;
    if (this.phase === 'question') {
      focus = this.button(actions, '答えを表示（Space）', 'mod-cta kioku-review-reveal', () => this.reveal());
    } else {
      const intervals = previewIntervals(this.ctx.store.state.cards[card.id] ?? null, this.ctx.today);
      const disabled = this.phase !== 'answer' || this.ctx.store.readOnly;
      for (const grade of GRADES) {
        const label = intervalLabel(intervals[grade]);
        const button = this.button(actions, `${GRADE_LABEL[grade]}（${grade}）· ${label}`,
          `kioku-review-grade${grade === 3 ? ' mod-cta' : ''}`, () => void this.rate(grade), disabled);
        button.dataset.kiokuGrade = String(grade);
        button.setAttribute('aria-label', `${GRADE_LABEL[grade]}（キー ${grade}）：次回 ${label}後`);
        if (grade === 3 && !disabled) focus = button;
      }
    }
    const busy = this.phase === 'saving' || this.phase === 'failed';
    this.button(actions, 'スキップ（S）', 'kioku-review-skip', () => this.skip(), busy);
    const message = screen.createDiv({ cls: 'kioku-review-message' });
    if (this.phase === 'saving') message.setText('保存しています…');
    if (this.phase === 'failed') {
      message.setText(this.failure);
      focus = this.button(actions, 'もう一度保存する', 'mod-cta kioku-review-retry', () => void this.save());
    }
    const footer = screen.createDiv({ cls: 'kioku-review-footer' });
    // After a failed save only "もう一度保存する" (same event) or closing remains: leaving silently could lose it.
    this.button(footer, 'ノートを開く', 'kioku-review-open', () => this.ctx.openNote(card), busy);
    this.button(footer, 'デッキ選択に戻る', 'kioku-review-back', () => this.ctx.backToPicker(), busy);
    (focus ?? screen).focus();
  }

  private renderDone(screen: HTMLElement): void {
    const done = screen.createDiv({ cls: 'kioku-review-done' });
    done.createEl('p', { cls: 'kioku-review-summary', text: `評価 ${this.queue.rated} 枚・スキップ ${this.queue.skipped} 枚` });
    const held = this.queue.heldBack(this.allowance());
    const actions = done.createDiv({ cls: 'kioku-review-actions' });
    let focus: HTMLButtonElement | null = null;
    if (held > 0) {
      done.createEl('p', { cls: 'kioku-review-held', text: `今日の新規の上限に達しました。新規 ${held} 枚は明日以降に出題されます。` });
      if (!this.ctx.store.readOnly) {
        for (const count of EXTRA_NEW) {
          const button = this.button(actions, `今日だけ あと${count}枚`, 'kioku-review-extra', () => void this.addExtra(count),
            this.phase !== 'done');
          button.dataset.kiokuExtra = String(count);
          focus ??= button;
        }
      }
    } else if (this.queue.rated + this.queue.skipped === 0) {
      done.createEl('p', { cls: 'kioku-review-empty', text: 'このデッキに今日の復習はありません。' });
    }
    const busy = this.phase !== 'done';
    const back = this.button(actions, 'デッキ選択に戻る', 'kioku-review-back', () => this.ctx.backToPicker(), busy);
    this.button(actions, '閉じる', 'kioku-review-close', () => this.ctx.close(), busy);
    (busy ? screen : focus ?? back).focus();
  }

  private renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string): void {
    const component = this.component;
    if (!component) return;
    MarkdownRenderer.render(this.ctx.app, markdown, el, sourcePath, component).catch(() => {
      el.empty();
      el.setText(markdown);
    });
  }
}
