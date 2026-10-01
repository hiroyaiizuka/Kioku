import { Plugin } from 'obsidian';
import { StartupModal } from './ui/startup-modal';

export default class KiokuPlugin extends Plugin {
  private startupModal: StartupModal | null = null;

  override onload(): void {
    const openStartup = (): void => {
      this.startupModal ??= new StartupModal(this.app, {
        version: __KIOKU_VERSION__,
        buildId: __KIOKU_BUILD_ID__,
      });
      this.startupModal.open();
    };
    const ribbon = this.addRibbonIcon('gallery-vertical-end', 'フラッシュカード', openStartup);
    ribbon.addClass('kioku-ribbon');
    this.addCommand({
      id: 'open-startup',
      name: 'フラッシュカード（起動確認）',
      callback: openStartup,
    });
  }

  override onunload(): void {
    this.startupModal?.close();
    this.startupModal = null;
  }
}
