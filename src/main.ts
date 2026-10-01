import { Plugin, TFile, type Modal } from 'obsidian';
import { extractFromActiveNote, extractFromFile, hasActiveNote, type ModalTracker } from './ui/extract';
import { StartupModal } from './ui/startup-modal';

export default class KiokuPlugin extends Plugin {
  private startupModal: StartupModal | null = null;
  private readonly openModals = new Set<Modal>();

  override onload(): void {
    const tracker: ModalTracker = { add: (modal) => this.openModals.add(modal), delete: (modal) => this.openModals.delete(modal) };
    const extract = (): void => extractFromActiveNote(this.app, tracker);
    const openStartup = (): void => {
      this.startupModal ??= new StartupModal(this.app, {
        version: __KIOKU_VERSION__,
        buildId: __KIOKU_BUILD_ID__,
      }, extract);
      this.startupModal.open();
    };
    const ribbon = this.addRibbonIcon('gallery-vertical-end', 'フラッシュカード', openStartup);
    ribbon.addClass('kioku-ribbon');
    this.addCommand({
      id: 'open-startup',
      name: 'フラッシュカード（状態）',
      callback: openStartup,
    });
    this.addCommand({
      id: 'extract-explicit-qa',
      name: '開いているノート・選択範囲から問い・答えの候補を抽出',
      checkCallback: (checking) => {
        if (!hasActiveNote(this.app)) return false;
        if (!checking) extract();
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem((item) => item.setTitle('Kioku：問い・答えの候補を抽出').setIcon('gallery-vertical-end')
        .onClick(() => { void extractFromFile(this.app, file, tracker); }));
    }));
  }

  override onunload(): void {
    this.startupModal?.close();
    this.startupModal = null;
    for (const modal of [...this.openModals]) modal.close();
    this.openModals.clear();
  }
}
