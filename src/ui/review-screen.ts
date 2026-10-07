import { Component, MarkdownRenderer, Notice, setIcon, type App } from 'obsidian';
import { errorMessage } from '../cards/error-message';
import { hideEmbeds } from '../review/conceal';
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
  readonly cards: readonly ReviewCard[];
  /** Tag of the deck, as its picker row shows it (e.g. `#医学/生理`). */
  readonly deckLabel: string;
  readonly today: KiokuDay;
  readonly now: () => Date;
  /** Called after a 今日だけ追加 (the picker keeps an unsaved one across reloads). */
  readonly onExtraNew: (count: number) => void;
  readonly openNote: (card: ReviewCard) => void;
  readonly backToPicker: () => void;
  readonly close: () => void;
}

const GRADE_LABEL: Record<Grade, string> = { 1: 'もう一度', 2: '難しい', 3: '普通', 4: '簡単' };
const EXTRA_NEW = [10, 20] as const;
const DAY_CHANGED = 'Kioku：日付が変わったため、評価せずにデッキ選択を読み直しました。';

type Phase = 'question' | 'answer' | 'saving' | 'failed' | 'done';
type Action = () => void;

/**
 * Question → reveal → rate (1–4) → next, inside the deck picker modal. Keyboard input arrives
 * through `handleKey` only (one path; native button activation by Space/Enter is suppressed), so a
 * focused button and the shortcut can never both act. Key repeat and IME composition are ignored,
 * and rating/navigation actions are blocked while saving; the gear menu can still open and close.
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
  private menuOpen = false;
  /** Set when the gear or Escape toggles the menu: the next render focuses the menu or returns focus to the gear. */
  private menuFocus: 'menu' | 'gear' | null = null;

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
    // Escape closes an open menu only (not the modal), also while saving.
    if (key === 'Escape') return this.menuOpen && this.current ? () => this.toggleMenu(false) : undefined;
    const activation = key === ' ' || key === 'Enter';
    if (!activation && !['1', '2', '3', '4', 's', 'S'].includes(key)) return undefined;
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

  /** Every keyboard-operable action shows its key the same way: a badge after the label (not read aloud twice). */
  private keyBadge(button: HTMLButtonElement, key: string): void {
    button.createSpan({ cls: 'kioku-review-key', text: key }).setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-keyshortcuts', key);
  }

  private toggleMenu(open: boolean): void {
    this.menuOpen = open;
    this.menuFocus = open ? 'menu' : 'gear';
    this.render();
  }

  private advance(): void {
    this.menuOpen = false;
    this.menuFocus = null;
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
    this.ctx.onExtraNew(count);
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
    screen.addEventListener('click', () => {
      if (this.menuOpen) this.toggleMenu(false);
    });
    const busy = this.phase === 'saving' || this.phase === 'failed';
    const gearButton = this.renderHeader(screen, busy);
    const firstMenuItem = screen.querySelector<HTMLButtonElement>('.kioku-review-menu-item');
    const body = screen.createDiv({ cls: 'kioku-review-body' });
    if (this.ctx.store.readOnly) {
      body.createDiv({ cls: 'kioku-review-readonly', text: '読み取り専用：評価は保存できません（スキップと閲覧だけできます）。' });
    }
    const footer = screen.createDiv({ cls: 'kioku-review-footer' });
    if (this.phase === 'done' || !this.current) {
      this.renderDone(body, footer, screen);
      return;
    }
    const card = this.current;
    const shown = this.phase !== 'question';
    body.createDiv({ cls: 'kioku-review-qa-label', text: '問題' });
    const question = body.createDiv({ cls: 'kioku-review-question markdown-rendered' });
    this.renderMarkdown(shown ? card.question : hideEmbeds(card.question), question, card.path);
    if (shown) {
      body.createDiv({ cls: 'kioku-review-divider' });
      body.createDiv({ cls: 'kioku-review-qa-label', text: '答え' });
      const answer = body.createDiv({ cls: 'kioku-review-answer markdown-rendered' });
      this.renderMarkdown(card.answer, answer, card.path);
    }
    let focus: HTMLButtonElement | null = null;
    if (this.phase === 'question') {
      focus = this.button(footer, '答えを表示', 'mod-cta kioku-review-reveal', () => this.reveal());
      this.keyBadge(focus, 'Space');
    } else {
      const grades = footer.createDiv({ cls: 'kioku-review-grades' });
      const intervals = previewIntervals(this.ctx.store.state.cards[card.id] ?? null, this.ctx.today);
      const disabled = this.phase !== 'answer' || this.ctx.store.readOnly;
      for (const grade of GRADES) {
        const label = intervalLabel(intervals[grade]);
        // Each grade has its own color (docs/ui-design.md §2), so none of them is mod-cta.
        const button = this.button(grades, '', 'kioku-review-grade', () => void this.rate(grade), disabled);
        button.createSpan({ cls: 'kioku-review-grade-label', text: GRADE_LABEL[grade] });
        button.createSpan({ cls: 'kioku-review-interval', text: label });
        this.keyBadge(button, String(grade));
        button.dataset.kiokuGrade = String(grade);
        button.setAttribute('aria-label', `${GRADE_LABEL[grade]}（キー ${grade}）：次回 ${label}後`);
        if (grade === 3 && !disabled) focus = button;
      }
    }
    // Below the grades, so starting a save never moves the buttons under the pointer.
    if (busy) {
      const status = footer.createDiv({ cls: 'kioku-review-status' });
      status.createDiv({ cls: 'kioku-review-message', text: this.phase === 'saving' ? '保存しています…' : this.failure });
      if (this.phase === 'failed') {
        focus = this.button(status, 'もう一度保存する', 'mod-cta kioku-review-retry', () => void this.save());
      }
    }
    const menuFocus = this.menuFocus;
    this.menuFocus = null;
    const menuTarget = firstMenuItem && !firstMenuItem.disabled ? firstMenuItem : focus ?? gearButton;
    ((menuFocus === 'menu' ? menuTarget : menuFocus === 'gear' ? gearButton : focus) ?? screen).focus();
  }

  /**
   * ← (back to the decks) | the deck tag and progress | gear menu, then the space of Obsidian's ×.
   * Returns the gear, which exists only while a card is shown (its items all act on the card).
   */
  private renderHeader(screen: HTMLElement, busy: boolean): HTMLButtonElement | null {
    const header = screen.createDiv({ cls: 'kioku-modal-header kioku-review-header' });
    const start = header.createDiv({ cls: 'kioku-modal-header-start' });
    const back = this.button(start, '', 'clickable-icon kioku-review-back-button', () => this.ctx.backToPicker(),
      this.phase === 'done' ? false : busy);
    setIcon(back, 'arrow-left');
    back.setAttribute('aria-label', 'デッキに戻る');
    const handled = this.queue.rated + this.queue.skipped;
    const total = handled + this.queue.remaining(this.allowance());
    const position = this.current && this.phase !== 'done' ? handled + 1 : handled;
    const progress = header.createDiv({ cls: 'kioku-review-progress' });
    progress.setAttribute('aria-label', `${this.ctx.deckLabel}：${position} / ${total} 枚`);
    progress.createSpan({ cls: 'kioku-review-progress-deck', text: this.ctx.deckLabel }).setAttribute('aria-hidden', 'true');
    progress.createSpan({ cls: 'kioku-review-progress-separator' }).setAttribute('aria-hidden', 'true');
    const count = progress.createSpan({ cls: 'kioku-review-progress-count', text: `${position}/${total}` });
    count.setAttribute('aria-hidden', 'true');
    setIcon(count.createSpan({ cls: 'kioku-review-progress-icon' }), 'gallery-vertical-end');
    const end = header.createDiv({ cls: 'kioku-modal-header-end' });
    let gearButton: HTMLButtonElement | null = null;
    if (this.current && this.phase !== 'done') {
      const card = this.current;
      const gearWrapper = end.createDiv({ cls: 'kioku-review-gear-wrapper' });
      gearWrapper.addEventListener('click', (evt) => evt.stopPropagation());
      gearButton = this.button(gearWrapper, '', 'clickable-icon kioku-review-gear-button',
        () => this.toggleMenu(!this.menuOpen));
      setIcon(gearButton, 'settings');
      gearButton.setAttribute('aria-label', 'メニュー');
      gearButton.setAttribute('aria-expanded', String(this.menuOpen));
      // Obsidian's own pressed look for an icon button whose menu is open.
      if (this.menuOpen) gearButton.addClass('is-active');
      if (this.menuOpen) {
        const menu = gearWrapper.createDiv({ cls: 'kioku-review-gear-menu' });
        this.keyBadge(this.button(menu, 'スキップ', 'kioku-review-menu-item kioku-review-skip', () => this.skip(), busy), 'S');
        this.button(menu, '元のノートを開く', 'kioku-review-menu-item', () => {
          this.menuOpen = false;
          this.ctx.openNote(card);
        }, busy);
        this.button(menu, 'デッキに戻る', 'kioku-review-menu-item', () => {
          this.menuOpen = false;
          this.ctx.backToPicker();
        }, busy);
      }
    }
    // Keeps the space where Obsidian draws the modal's × button.
    end.createSpan({ cls: 'kioku-modal-close-space' });
    return gearButton;
  }

  private renderDone(body: HTMLElement, footer: HTMLElement, screen: HTMLElement): void {
    const done = body.createDiv({ cls: 'kioku-review-done' });
    done.createEl('p', { cls: 'kioku-review-summary', text: `評価 ${this.queue.rated} 枚・スキップ ${this.queue.skipped} 枚` });
    const held = this.queue.heldBack(this.allowance());
    const actions = footer.createDiv({ cls: 'kioku-review-actions' });
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
