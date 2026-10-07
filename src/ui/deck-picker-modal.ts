import { Menu, Modal, Notice, Scope, setIcon, type App } from 'obsidian';
import { errorMessage } from '../cards/error-message';
import { buildDeckIndex, type DeckIndex } from '../decks/index';
import { scanVault, type ScanResult } from '../decks/scan';
import { kiokuDay } from '../review/day';
import { countCards, newAllowance, type RatingLookup, type ReviewCard } from '../review/queue';
import type { CardSchedule, KiokuDay, KiokuSettings } from '../review/types';
import { STORE_REASONS, notIndexed } from '../store/reasons';
import { ReviewStore } from '../store/review-store';
import { ReviewScreen } from './review-screen';
import type { BuildIdentity } from './startup-modal';

export interface DeckPickerOptions {
  readonly identity: BuildIdentity;
  readonly settings: () => Promise<KiokuSettings>;
  readonly openStatus: () => void;
  readonly extract: () => void;
  readonly now: () => Date;
  readonly onClosed?: () => void;
}

interface Loaded {
  readonly settings: KiokuSettings;
  readonly store: ReviewStore;
  readonly scan: ScanResult;
  readonly index: DeckIndex;
  readonly today: KiokuDay;
}

/** The three columns, left to right, each colored by its `mod-<kind>` class. */
const COLUMNS = [
  { kind: 'new', title: '新規' },
  { kind: 'learning', title: '学習中' },
  { kind: 'due', title: '復習' },
] as const;

/** Only reachable when the allowance is finite (more new cards than it). */
const formatLater = (allowance: number): string => `今日の新規は残り ${allowance} 枚（残りは明日以降）`;
/** Below the list, only while today's limit holds new cards back (across all decks). */
const formatHeldBack = (count: number): string => `新規は残り ${count} 枚が明日以降`;

const dataFolderNote = (folder: string): string =>
  `学習の記録と日程は Vault の「${folder}」フォルダに保存されます（最初の評価で作成）。このフォルダを削除・移動すると記録が失われます。`;
const DATA_NOTE_MS = 10000;

/**
 * Ribbon target: a flat list of the tag decks with 新規 / 学習中 / 復習, then the review screen in the same modal.
 * Opening scans notes read-only and reads `<dataFolder>/` without creating or writing anything.
 */
export class DeckPickerModal extends Modal {
  private generation = 0;
  private loaded: Loaded | null = null;
  private review: ReviewScreen | null = null;
  private moreButton: HTMLButtonElement | null = null;
  /** "今日だけ追加" not yet on disk (no rating yet): re-applied after the picker reloads the store. */
  private unsavedExtra: { folder: string; day: KiokuDay; count: number } | null = null;
  private readonly onKeyDown = (evt: KeyboardEvent): void => {
    this.review?.handleKey(evt);
  };
  /** Space activates a focused button on keyup; the review screen already handled the keydown. */
  private readonly onKeyUp = (evt: KeyboardEvent): void => {
    if (this.review && (evt.key === ' ' || evt.key === 'Enter') && !evt.isComposing) evt.preventDefault();
  };

  constructor(app: App, private readonly options: DeckPickerOptions) {
    super(app);
    // Native Obsidian dispatches Scope hotkeys before DOM capture listeners.
    // Keep the modal's original scope as parent so its other bindings survive.
    this.scope = new Scope(this.scope);
    this.scope.register([], 'Escape', (evt) => {
      if (!this.review?.handleKey(evt)) this.close();
      return false;
    });
  }

  override onOpen(): void {
    this.modalEl.addClass('kioku-deck-picker-modal');
    this.modalEl.dataset.kiokuBuildId = this.options.identity.buildId;
    this.modalEl.dataset.kiokuVersion = this.options.identity.version;
    this.containerEl.addEventListener('keydown', this.onKeyDown, true);
    this.containerEl.addEventListener('keyup', this.onKeyUp, true);
    void this.load();
  }

  override onClose(): void {
    this.generation += 1;
    this.containerEl.removeEventListener('keydown', this.onKeyDown, true);
    this.containerEl.removeEventListener('keyup', this.onKeyUp, true);
    this.review?.dispose();
    this.review = null;
    this.loaded = null;
    this.moreButton = null;
    this.contentEl.empty();
    this.options.onClosed?.();
  }

  private async load(): Promise<void> {
    const generation = this.generation += 1;
    this.review?.dispose();
    this.review = null;
    this.renderFrame().createEl('p', { cls: 'kioku-deck-loading', text: '読み込んでいます…' });
    let loaded: Loaded;
    try {
      const settings = await this.options.settings();
      const scan = await scanVault(this.app, settings.triggerTags);
      const store = await ReviewStore.load(this.app.vault.adapter, settings.dataFolder);
      const today = kiokuDay(this.options.now(), settings.dayStartHour);
      const extra = this.unsavedExtra;
      if (extra && extra.folder === settings.dataFolder && extra.day === today && !store.persistsExtraNew) {
        store.applyExtraNew(extra.day, extra.count);
      } else {
        this.unsavedExtra = null;
      }
      loaded = { settings, store, scan, index: buildDeckIndex(scan.notes, settings.triggerTags), today };
    } catch (error) {
      if (generation !== this.generation) return;
      this.renderFrame().createEl('p', { cls: 'kioku-deck-problem', text: `読み込めませんでした（${errorMessage(error)}）。` });
      this.moreButton?.focus();
      return;
    }
    if (generation !== this.generation) return;
    this.loaded = loaded;
    this.renderPicker();
  }

  private renderPicker(): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const { settings, store, index, today, scan } = loaded;
    const lookup = (id: string): CardSchedule | undefined => store.state.cards[id];
    const ratings = store.lastRatings();
    const lastRating: RatingLookup = (id) => ratings.get(id);
    const allowance = newAllowance(store.state.today, today, settings.newPerDay);
    const body = this.renderFrame();
    if (store.problem) this.renderProblem(body, store);
    const list = body.createDiv({ cls: 'kioku-deck-list' });
    if (index.listed.length) {
      const columns = list.createDiv({ cls: 'kioku-deck-columns' });
      // The rows' aria-labels name every count, so the visual column titles are not read again.
      columns.setAttribute('aria-hidden', 'true');
      columns.createSpan();
      for (const column of COLUMNS) columns.createSpan({ cls: `kioku-deck-column mod-${column.kind}`, text: column.title });
    }
    // With a single trigger tag every row starts with it, so it is left out of the titles.
    const single = settings.triggerTags.length === 1 ? settings.triggerTags[0]?.toLowerCase() : undefined;
    for (const deck of index.listed) {
      const label = `#${single !== undefined && deck.key.startsWith(`${single}/`) ? deck.label.slice(single.length + 1) : deck.label}`;
      const cards = [...deck.cardIds].map((id) => index.cards.get(id)).filter((card): card is ReviewCard => card !== undefined);
      const counts = countCards(cards, lookup, lastRating, today);
      const item = list.createEl('button', { cls: 'kioku-deck-row' });
      item.dataset.kiokuDeck = deck.key;
      item.createSpan({ cls: 'kioku-deck-name', text: label });
      for (const column of COLUMNS) {
        const count = counts[column.kind];
        item.createSpan({ cls: `kioku-deck-count mod-${column.kind}${count === 0 ? ' is-zero' : ''}`, text: String(count) });
      }
      const later = counts.new > allowance ? `、${formatLater(allowance)}` : '';
      if (later) item.dataset.kiokuLater = String(allowance);
      item.setAttribute('aria-label', `${label}：${COLUMNS.map((column) => `${column.title} ${counts[column.kind]} 枚`).join('、')}${later}`);
      item.addEventListener('click', () => this.startReview(label, cards));
    }
    const notes = body.createDiv({ cls: 'kioku-deck-notes' });
    const heldBack = countCards(index.cards.values(), lookup, lastRating, today).new - allowance;
    if (heldBack > 0) notes.createEl('p', { cls: 'kioku-deck-later', text: formatHeldBack(heldBack) });
    const tagList = settings.triggerTags.map((tag) => `#${tag}`).join('、');
    if (!index.all.size) {
      notes.createEl('p', { cls: 'kioku-deck-empty',
        text: `デッキにカードがありません。ノートにトリガータグ（${tagList}）を付け、問い・答えを採用するとここに表示されます。` });
    }
    if (index.untagged) {
      notes.createEl('p', { cls: 'kioku-deck-untagged',
        text: `デッキに属していないカード ${index.untagged} 枚（トリガータグ ${tagList} を付けると出題されます）。` });
    }
    for (const conflict of index.conflicts) {
      notes.createEl('p', { cls: 'kioku-deck-conflict',
        text: `内容の異なる同じ ID（${conflict.id}）のため出題しません：${conflict.paths.join(' / ')}` });
    }
    if (scan.notIndexed) notes.createEl('p', { cls: 'kioku-deck-not-indexed', text: notIndexed(scan.notIndexed) });
    for (const invalid of scan.invalidIds) {
      notes.createEl('p', { cls: 'kioku-deck-invalid-id', text: `カード ID として使えない ID（^${invalid.id}）のため出題しません：${invalid.path}` });
    }
    for (const failed of scan.unreadable) {
      notes.createEl('p', { cls: 'kioku-deck-unreadable', text: `読めなかったノート：${failed.path}（${failed.reason}）` });
    }
    (list.querySelector<HTMLButtonElement>('.kioku-deck-row') ?? this.moreButton)?.focus();
  }

  /** Header (title, ⋯ and Obsidian's own ×) over an emptied body; returns the body. */
  private renderFrame(): HTMLElement {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.classList.remove('kioku-is-reviewing');
    const header = contentEl.createDiv({ cls: 'kioku-modal-header' });
    const title = header.createDiv({ cls: 'kioku-deck-title', text: 'デッキ' });
    title.setAttribute('role', 'heading');
    title.setAttribute('aria-level', '2');
    const end = header.createDiv({ cls: 'kioku-modal-header-end' });
    const more = this.moreButton = end.createEl('button', { cls: 'clickable-icon kioku-deck-more' });
    setIcon(more, 'more-horizontal');
    more.setAttribute('aria-label', 'その他の操作');
    more.addEventListener('click', () => this.openMenu(more));
    // Keeps the space where Obsidian draws the modal's × button.
    end.createSpan({ cls: 'kioku-modal-close-space' });
    return contentEl.createDiv({ cls: 'kioku-deck-body' });
  }

  private openMenu(anchor: HTMLElement): void {
    const dataFolder = this.loaded?.settings.dataFolder;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle('問い・答えの候補を抽出').setIcon('gallery-vertical-end').onClick(() => {
      this.close();
      this.options.extract();
    }));
    menu.addItem((item) => item.setTitle('状態').setIcon('info').onClick(() => {
      this.close();
      this.options.openStatus();
    }));
    if (dataFolder !== undefined) {
      menu.addItem((item) => item.setTitle('記録の保存先について').setIcon('folder').onClick(() => {
        new Notice(dataFolderNote(dataFolder), DATA_NOTE_MS);
      }));
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.bottom, left: true }, anchor.ownerDocument);
  }

  private renderProblem(parent: HTMLElement, store: ReviewStore): void {
    const problem = store.problem;
    if (!problem) return;
    const box = parent.createDiv({ cls: 'kioku-deck-problem' });
    box.createEl('p', { text: problem.message });
    if (problem.kind !== 'truncated') return;
    box.createEl('p', { text: `確認すると、その1行だけを ${problem.file}.broken に退避してから記録ファイルから取り除き、続行します。${STORE_REASONS.truncatedLost}` });
    const repair = box.createEl('button', { text: '不完全な最終行を退避して続ける', cls: 'mod-warning kioku-deck-repair' });
    repair.addEventListener('click', () => {
      repair.disabled = true;
      void this.repair(store);
    });
  }

  private async repair(store: ReviewStore): Promise<void> {
    const generation = this.generation;
    const result = await store.repairTruncated();
    if (generation !== this.generation) return;
    if (!result.ok) {
      new Notice(`Kioku：退避できませんでした。${result.reason}`);
      void this.load();
      return;
    }
    new Notice('Kioku：不完全な最終行を退避しました。');
    void this.load();
  }

  private startReview(label: string, cards: readonly ReviewCard[]): void {
    const loaded = this.loaded;
    if (!loaded) return;
    this.moreButton = null;
    this.modalEl.classList.add('kioku-is-reviewing');
    this.review = new ReviewScreen({
      app: this.app,
      container: this.contentEl,
      store: loaded.store,
      settings: loaded.settings,
      cards,
      deckLabel: label,
      today: loaded.today,
      now: this.options.now,
      onExtraNew: (count) => {
        if (loaded.store.persistsExtraNew) return;
        const previous = this.unsavedExtra?.day === loaded.today ? this.unsavedExtra.count : 0;
        this.unsavedExtra = { folder: loaded.settings.dataFolder, day: loaded.today, count: previous + count };
      },
      openNote: (card) => {
        this.close();
        void this.app.workspace.openLinkText(`${card.path}#^${card.id}`, '', false);
      },
      backToPicker: () => void this.load(),
      close: () => this.close(),
    });
    this.review.start();
  }
}
