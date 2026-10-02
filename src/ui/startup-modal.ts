import { App, Modal } from 'obsidian';

export interface BuildIdentity {
  readonly version: string;
  readonly buildId: string;
}

/**
 * Status popup (command and deck picker button). Opening it never reads or writes notes; the
 * extract button hands control to the explicit extraction action.
 */
export class StartupModal extends Modal {
  constructor(app: App, private readonly identity: BuildIdentity, private readonly onExtract: () => void) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.modalEl.addClass('kioku-startup-modal');
    this.setTitle('Kioku — 状態');
    this.contentEl.createEl('p', {
      text: '開発版：トリガータグ（既定 #kioku）のデッキで、採用したカードを間隔反復の日程で復習できます（左の「フラッシュカード」ボタン）。問い・答えの候補確認・採用も使えます。専用の確認用保管場所での実機確認はまだです。',
      cls: 'kioku-startup-status',
    });
    this.contentEl.createEl('p', {
      text: 'AI による候補作成は未実装です。',
      cls: 'kioku-startup-unimplemented',
    });
    this.contentEl.createEl('p', {
      text: 'この画面を開くだけではノートを読み書きしません。外部送信も行いません。復習の記録は学習データのフォルダ（設定で変更可）にだけ保存し、ノート本文は書き換えません。',
    });
    const build = this.contentEl.createEl('p', { cls: 'kioku-build-identity' });
    build.createSpan({ text: `Kioku ${this.identity.version} · Build ${this.identity.buildId}` });
    build.dataset.kiokuBuildId = this.identity.buildId;
    build.dataset.kiokuVersion = this.identity.version;
    const actions = this.contentEl.createDiv({ cls: 'kioku-startup-actions' });
    const extract = actions.createEl('button', { text: '開いているノートから問い・答えの候補を抽出', cls: 'mod-cta kioku-startup-extract' });
    extract.addEventListener('click', () => {
      this.close();
      this.onExtract();
    });
    const close = actions.createEl('button', { text: '閉じる', cls: 'kioku-startup-close' });
    close.addEventListener('click', () => this.close());
    close.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
