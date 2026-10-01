import { App, Modal } from 'obsidian';

export interface BuildIdentity {
  readonly version: string;
  readonly buildId: string;
}

export class StartupModal extends Modal {
  constructor(app: App, private readonly identity: BuildIdentity) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.modalEl.addClass('kioku-startup-modal');
    this.setTitle('Kioku — 起動確認');
    this.contentEl.createEl('p', {
      text: 'M0 開発基盤：カード作成・保存・デッキ・復習は未実装です。',
      cls: 'kioku-startup-status',
    });
    this.contentEl.createEl('p', {
      text: 'この画面は起動確認専用です。ノートの読み取り・書き込みや外部送信は行いません。',
    });
    const build = this.contentEl.createEl('p', { cls: 'kioku-build-identity' });
    build.createSpan({ text: `Kioku ${this.identity.version} · Build ${this.identity.buildId}` });
    build.dataset.kiokuBuildId = this.identity.buildId;
    build.dataset.kiokuVersion = this.identity.version;
    const close = this.contentEl.createEl('button', { text: '閉じる', cls: 'kioku-startup-close' });
    close.addEventListener('click', () => this.close());
    close.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
