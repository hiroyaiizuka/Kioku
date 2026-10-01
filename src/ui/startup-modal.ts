import { App, Modal } from 'obsidian';

export interface BuildIdentity {
  readonly version: string;
  readonly buildId: string;
}

/**
 * Ribbon status popup. Opening it never reads or writes notes; the extract button hands
 * control to the explicit extraction action.
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
      text: 'M1：開いているノート（または選択範囲）の明示 Q/A を候補として確認・編集し、採用したものだけ元ノートへ保存できます。',
      cls: 'kioku-startup-status',
    });
    this.contentEl.createEl('p', {
      text: 'デッキ・復習（間隔反復）・AI による候補作成は未実装です。',
      cls: 'kioku-startup-unimplemented',
    });
    this.contentEl.createEl('p', {
      text: 'この画面を開くだけではノートを読み書きしません。外部送信も行いません。',
    });
    const build = this.contentEl.createEl('p', { cls: 'kioku-build-identity' });
    build.createSpan({ text: `Kioku ${this.identity.version} · Build ${this.identity.buildId}` });
    build.dataset.kiokuBuildId = this.identity.buildId;
    build.dataset.kiokuVersion = this.identity.version;
    const actions = this.contentEl.createDiv({ cls: 'kioku-startup-actions' });
    const extract = actions.createEl('button', { text: '開いているノートから Q/A 候補を抽出', cls: 'mod-cta kioku-startup-extract' });
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
