import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { normalizeTriggerTags } from '../decks/tags';
import { MAX_NEW_PER_DAY, normalizeDataFolder, type SettingsStore } from '../store/settings';
import { checkFolderChange } from '../store/review-store';

/** Kioku settings (stored in the plugin's data.json; review data stays in the data folder). */
export class KiokuSettingTab extends PluginSettingTab {
  private generation = 0;

  constructor(app: App, plugin: Plugin, private readonly settings: SettingsStore) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();
    void this.render();
  }

  override hide(): void {
    this.generation += 1;
    this.containerEl.empty();
  }

  private async render(): Promise<void> {
    const generation = this.generation += 1;
    const current = await this.settings.get();
    if (generation !== this.generation) return;
    const { containerEl } = this;
    containerEl.empty();

    const tagStatus: HTMLElement = new Setting(containerEl)
      .setName('トリガータグ')
      .setDesc('このタグ（子タグを含む）を付けたノートのカードがデッキになります。複数はカンマ区切り。大文字小文字は区別しません。')
      .addText((text) => text
        .setPlaceholder('例：#kioku, #英単語')
        .setValue(current.triggerTags.map((tag) => `#${tag}`).join(', '))
        .onChange(async (value) => {
          const tags = normalizeTriggerTags(value.split(/[,、\s]+/));
          if (!tags.length) {
            tagStatus.setText('タグを1つ以上入力してください（数字だけのタグは使えません）。保存していません。');
            return;
          }
          tagStatus.setText('');
          await this.settings.update({ triggerTags: tags });
        }))
      .descEl.createDiv({ cls: 'kioku-settings-status' });

    const unlimited = current.newPerDay === null;
    const limitStatus: HTMLElement = new Setting(containerEl)
      .setName('1日の新規カード数')
      .setDesc('その日に初めて出題するカードの上限（全デッキ共通）。期日のカードには上限がありません。')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.setValue(String(current.newPerDay ?? 20)).setDisabled(unlimited)
          .onChange(async (value) => {
            const count = Number(value);
            if (!/^\d+$/.test(value.trim()) || count > MAX_NEW_PER_DAY) {
              limitStatus.setText(`0〜${MAX_NEW_PER_DAY} の整数を入力してください。保存していません。`);
              return;
            }
            limitStatus.setText('');
            await this.settings.update({ newPerDay: count });
          });
      })
      .addToggle((toggle) => toggle
        .setTooltip('上限なし')
        .setValue(unlimited)
        .onChange(async (value) => {
          const latest = await this.settings.get();
          await this.settings.update({ newPerDay: value ? null : latest.newPerDay ?? 20 });
          this.display();
        }))
      .descEl.createDiv({ cls: 'kioku-settings-status' });

    new Setting(containerEl)
      .setName('日付の切り替え時刻')
      .setDesc('この時刻より前の復習は前日分として数えます（既定 4:00）。')
      .addDropdown((dropdown) => {
        for (let hour = 0; hour < 24; hour += 1) dropdown.addOption(String(hour), `${hour}:00`);
        dropdown.setValue(String(current.dayStartHour)).onChange(async (value) => {
          await this.settings.update({ dayStartHour: Number(value) });
        });
      });

    let draft = current.dataFolder;
    const folderStatus: HTMLElement = new Setting(containerEl)
      .setName('学習データのフォルダ')
      .setDesc('日程（state.json）と評価の記録（history-年.jsonl）を保存するフォルダ（ノートと同じ保管場所の中）。変更してもファイルは移動しません。')
      .addText((text) => text.setValue(current.dataFolder).onChange((value) => {
        draft = value;
      }))
      .addButton((button) => button.setButtonText('変更').onClick(async () => {
        const next = normalizeDataFolder(draft);
        const latest = await this.settings.get();
        if (!next) {
          folderStatus.setText('使えないフォルダ名です（空、「.」で始まる、「..」を含むなど）。');
          return;
        }
        if (next === latest.dataFolder) {
          folderStatus.setText('変更はありません。');
          return;
        }
        const refusal = await checkFolderChange(this.app.vault.adapter, latest.dataFolder, next);
        if (refusal) {
          folderStatus.setText(refusal);
          return;
        }
        await this.settings.update({ dataFolder: next });
        folderStatus.setText(`「${next}」に変更しました。`);
      }))
      .descEl.createDiv({ cls: 'kioku-settings-status' });
  }
}

