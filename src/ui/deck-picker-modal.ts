import { Modal, Notice, Scope, type App } from 'obsidian';
import { errorMessage } from '../cards/error-message';
import { buildDeckIndex, type DeckIndex, type DeckNode } from '../decks/index';
import { scanVault, type ScanResult } from '../decks/scan';
import { kiokuDay } from '../review/day';
import { countCards, newAllowance, type ReviewCard } from '../review/queue';
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

const formatAllowance = (allowance: number): string =>
  Number.isFinite(allowance) ? `今日の新規 残り ${allowance} 枚` : '今日の新規 上限なし';

/**
 * Ribbon target: deck tree with Due / New / Total, then the review screen in the same modal.
 * Opening scans notes read-only and reads `<dataFolder>/` without creating or writing anything.
 */
export class DeckPickerModal extends Modal {
  private generation = 0;
  private loaded: Loaded | null = null;
  private review: ReviewScreen | null = null;
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
    this.setTitle('Kioku — デッキを選んで復習');
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
    this.contentEl.empty();
    this.options.onClosed?.();
  }

  private async load(): Promise<void> {
    const generation = this.generation += 1;
    this.review?.dispose();
    this.review = null;
    this.contentEl.empty();
    this.contentEl.createEl('p', { cls: 'kioku-deck-loading', text: '読み込んでいます…' });
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
      this.contentEl.empty();
      this.contentEl.createEl('p', { cls: 'kioku-deck-problem', text: `読み込めませんでした（${errorMessage(error)}）。` });
      this.renderFooter();
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
    const allowance = newAllowance(store.state.today, today, settings.newPerDay);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { cls: 'kioku-deck-allowance', text: formatAllowance(allowance) });
    if (store.problem) this.renderProblem(contentEl, store);
    const list = contentEl.createDiv({ cls: 'kioku-deck-list' });
    const cardsOf = (ids: Iterable<string>): ReviewCard[] =>
      [...ids].map((id) => index.cards.get(id)).filter((card): card is ReviewCard => card !== undefined);
    const row = (key: string, label: string, ids: Iterable<string>, depth: number): void => {
      const cards = cardsOf(ids);
      const counts = countCards(cards, lookup, today);
      const item = list.createEl('button', { cls: 'kioku-deck-row' });
      item.dataset.kiokuDeck = key;
      item.style.setProperty('--kioku-deck-depth', String(depth));
      item.createSpan({ cls: 'kioku-deck-name', text: label });
      item.createSpan({ cls: 'kioku-deck-counts', text: `Due ${counts.due} · New ${counts.new} · Total ${counts.total}` });
      if (counts.new > allowance) item.createSpan({ cls: 'kioku-deck-later', text: '新規の残りは明日以降' });
      item.setAttribute('aria-label', `${label}：期日 ${counts.due} 枚、新規 ${counts.new} 枚、合計 ${counts.total} 枚`);
      item.addEventListener('click', () => this.startReview(label, cards));
    };
    row('*', '全デッキ', index.all, 0);
    // With a single trigger tag its root deck equals 全デッキ, so only its children are listed.
    const single = settings.triggerTags.length === 1 ? settings.triggerTags[0]?.toLowerCase() : undefined;
    const tops = index.roots.flatMap((root) => (root.key === single ? root.children : [root]));
    const visit = (node: DeckNode, depth: number): void => {
      const label = single !== undefined && node.label.toLowerCase().startsWith(`${single}/`)
        ? node.label.slice(single.length + 1).split('/').join(' › ') : node.label.split('/').join(' › ');
      row(node.key, label, node.cardIds, depth);
      for (const child of node.children) visit(child, depth + 1);
    };
    for (const top of tops) visit(top, 1);
    const notes = contentEl.createDiv({ cls: 'kioku-deck-notes' });
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
    notes.createEl('p', { cls: 'kioku-deck-data-note',
      text: `学習の記録と日程は Vault の「${settings.dataFolder}」フォルダに保存されます（最初の評価で作成）。このフォルダを削除・移動すると記録が失われます。` });
    this.renderFooter();
    list.querySelector<HTMLButtonElement>('.kioku-deck-row')?.focus();
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

  private renderFooter(): void {
    const footer = this.contentEl.createDiv({ cls: 'kioku-deck-footer' });
    const status = footer.createEl('button', { text: '状態', cls: 'kioku-deck-picker-status' });
    status.addEventListener('click', () => {
      this.close();
      this.options.openStatus();
    });
    const extract = footer.createEl('button', { text: '問い・答えの候補を抽出', cls: 'kioku-deck-picker-extract' });
    extract.addEventListener('click', () => {
      this.close();
      this.options.extract();
    });
    const close = footer.createEl('button', { text: '閉じる', cls: 'kioku-deck-picker-close' });
    close.addEventListener('click', () => this.close());
  }

  private startReview(label: string, cards: readonly ReviewCard[]): void {
    const loaded = this.loaded;
    if (!loaded) return;
    this.setTitle(`Kioku — ${label}`);
    this.review = new ReviewScreen({
      app: this.app,
      container: this.contentEl,
      store: loaded.store,
      settings: loaded.settings,
      cards,
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
      backToPicker: () => {
        this.setTitle('Kioku — デッキを選んで復習');
        void this.load();
      },
      close: () => this.close(),
    });
    this.review.start();
  }
}
