import { Plugin, TFile, type Modal } from 'obsidian';
import { browserClock, obsidianHttpClient } from './ai/http';
import { AiRuntime } from './ai/pipeline';
import { SettingsStore } from './store/settings';
import { extractFromActiveNote, extractFromFile, hasActiveNote, type ModalTracker } from './ui/extract';
import { CandidateModal } from './ui/candidate-modal';
import { DeckPickerModal } from './ui/deck-picker-modal';
import { KiokuSettingTab } from './ui/settings-tab';
import { StartupModal } from './ui/startup-modal';

export default class KiokuPlugin extends Plugin {
  private startupModal: StartupModal | null = null;
  private readonly openModals = new Set<Modal>();

  override onload(): void {
    const tracker: ModalTracker = { add: (modal) => this.openModals.add(modal), delete: (modal) => this.openModals.delete(modal) };
    const identity = { version: __KIOKU_VERSION__, buildId: __KIOKU_BUILD_ID__ };
    // Settings are read from data.json on first use, never during startup.
    const settings = new SettingsStore(() => this.loadData(), (data) => this.saveData(data));
    // Holds only in-flight slots; no network until a run button is pressed in the candidate popup.
    const ai = { runtime: new AiRuntime(obsidianHttpClient, browserClock), settings: () => settings.get() };
    const extract = (): void => extractFromActiveNote(this.app, tracker, ai);
    const openStatus = (): void => {
      this.startupModal ??= new StartupModal(this.app, identity, extract);
      this.startupModal.open();
    };
    const openDeckPicker = (): void => {
      const modal: DeckPickerModal = new DeckPickerModal(this.app, {
        identity, settings: () => settings.get(), openStatus, extract, now: () => new Date(),
        onClosed: () => tracker.delete(modal),
      });
      tracker.add(modal);
      modal.open();
    };
    const ribbon = this.addRibbonIcon('gallery-vertical-end', 'フラッシュカード', openDeckPicker);
    ribbon.addClass('kioku-ribbon');
    this.addCommand({
      id: 'open-review',
      name: 'デッキを選んで復習',
      callback: openDeckPicker,
    });
    this.addCommand({
      id: 'open-startup',
      name: 'フラッシュカード（状態）',
      callback: openStatus,
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
        .onClick(() => { void extractFromFile(this.app, file, tracker, ai); }));
    }));
    this.addSettingTab(new KiokuSettingTab(this.app, this, settings));
  }

  override onunload(): void {
    this.startupModal?.close();
    this.startupModal = null;
    for (const modal of [...this.openModals]) {
      if (modal instanceof CandidateModal) modal.closeSilently();
      else modal.close();
    }
    this.openModals.clear();
  }
}
