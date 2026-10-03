// The AI section of the settings tab (docs/m3-design.md §7, §8). Showing it never touches the
// network; keys are stored in data.json in plain text (Q5) and are never shown in full.
import { Setting } from 'obsidian';
import { JEV_HOST, LOCAL_DEFAULT_URLS, LOCAL_SERVER_LABELS, consentFingerprint, hasConsent, hostOf, isCloudModel,
  localIsExternal, maskedKey, normalizeBaseUrl, type AiSettings, type LocalServer } from '../ai/settings';

export interface AiSettingsSection {
  readonly current: AiSettings;
  /**
   * Applies `change` to the latest saved AI settings and saves (the rest of data.json is kept).
   * Never built on `current`: another field may have been saved since this section was drawn.
   */
  readonly save: (change: (latest: AiSettings) => AiSettings) => Promise<void>;
  /** Re-renders the settings tab (after a change that alters what is shown). */
  readonly redraw: () => void;
  /** Wraps async callbacks so a failed save becomes a Notice. */
  readonly guarded: <T extends unknown[]>(action: (...args: T) => Promise<void>) => (...args: T) => void;
}

export const PRIVACY_TEXT = [
  'AI で候補を作ると、このノートの本文（コードブロック・%% コメント・HTML コメント・数式ブロック・frontmatter を除く）が、選んだ AI サービスに送られます。ノート名・ファイルパス・Vault 名は送りません。',
  'このパソコン内のサーバー（localhost）で実行するモデルなら外部に送られません。ただし、Ollama の cloud モデル（名前が cloud で終わるもの）や、ローカルのサーバーが別のサービスへ中継する設定の場合は外部に送られます（中継は Kioku からは分かりません）。',
  '送信先での扱いは各サービスの規約に従います（例：TypeSafe AI は利用者データで学習しないと公表しています）。費用は利用者のアカウントに請求されます。キャンセルしても、送信済みの分は処理・請求されることがあります。',
  'API キーは、この Vault の設定フォルダにある Kioku の設定ファイル（plugins/kioku/data.json）に暗号化せずに保存されます。同期・Git・バックアップで Vault と一緒に複製され、他のプラグインからも読めます。利用上限を設定した専用のキーを使ってください。',
];

const SERVERS: readonly LocalServer[] = ['ollama', 'llamacpp', 'lmstudio'];

export function renderAiSettings(containerEl: HTMLElement, section: AiSettingsSection): void {
  const { current: ai, redraw, guarded } = section;
  // Text fields save on every keystroke and redraw on blur: the redraw waits for the last save so
  // it shows what was saved (e.g. the consent toggle for a new model).
  let lastSave: Promise<void> = Promise.resolve();
  const save = (change: (latest: AiSettings) => AiSettings): Promise<void> => {
    lastSave = section.save(change);
    return lastSave;
  };
  const redrawAfterSave = (): void => {
    void lastSave.then(redraw, redraw);
  };

  new Setting(containerEl).setName('AI による候補作成').setHeading();
  const privacy = containerEl.createDiv({ cls: 'kioku-ai-privacy' });
  for (const paragraph of PRIVACY_TEXT) privacy.createEl('p', { text: paragraph });

  new Setting(containerEl)
    .setName('AI を使う')
    .setDesc('既定はオフ。オンにしても、候補ポップアップで「AI で候補を作る」を押すまで通信しません。')
    .addToggle((toggle) => toggle.setValue(ai.enabled).onChange(guarded(async (value: boolean) => {
      await save((latest) => ({ ...latest, enabled: value }));
      redraw();
    })));
  if (!ai.enabled) return;

  // ---- generation: local OpenAI-compatible server (Q1) ----
  const local = ai.providers.local;
  const withLocal = (next: (latest: AiSettings) => Partial<AiSettings['providers']['local']>) => (latest: AiSettings): AiSettings =>
    ({ ...latest, providers: { ...latest.providers, local: { ...latest.providers.local, ...next(latest) } } });
  new Setting(containerEl)
    .setName('生成：ローカルのサーバー')
    .setDesc('ノートから問い・答えの候補を作るモデルを動かすサーバー（OpenAI 互換）。')
    .addDropdown((dropdown) => {
      for (const server of SERVERS) dropdown.addOption(server, LOCAL_SERVER_LABELS[server]);
      dropdown.setValue(local.server).onChange(guarded(async (value: string) => {
        const server = SERVERS.find((item) => item === value) ?? 'ollama';
        await save(withLocal(() => ({ server, baseUrl: LOCAL_DEFAULT_URLS[server] })));
        redraw();
      }));
    });
  const urlStatus: HTMLElement = new Setting(containerEl)
    .setName('生成：接続先')
    .setDesc('ホストとポートまで（パスは付けない）。既定は種類ごとの localhost のポートです。localhost 以外は外部への送信になります。')
    .addText((text) => {
      text.setValue(local.baseUrl).onChange(guarded(async (value: string) => {
        const url = normalizeBaseUrl(value);
        if (!url) {
          urlStatus.setText('HTTP か HTTPS の接続先を、ホストとポートまでで入力してください（/v1 などのパスは付けません）。保存していません。');
          return;
        }
        urlStatus.setText('');
        await save(withLocal(() => ({ baseUrl: url })));
      }));
      text.inputEl.addEventListener('change', redrawAfterSave);
    })
    .descEl.createDiv({ cls: 'kioku-settings-status' });
  new Setting(containerEl)
    .setName('生成：モデル名')
    .setDesc('サーバーで使うモデル名（例 qwen3:8b）。空のままでは AI で候補を作りません。推奨モデルは実測後に案内します。')
    .addText((text) => {
      text.setPlaceholder('モデル名').setValue(local.model).onChange(guarded(async (value: string) => {
        await save(withLocal(() => ({ model: value.trim() })));
      }));
      text.inputEl.addEventListener('change', redrawAfterSave);
    });
  if (localIsExternal(local)) {
    const cloud = isCloudModel(local.model);
    const host = hostOf(local.baseUrl);
    new Setting(containerEl)
      .setName(`外部への送信に同意する（${host}）`)
      .setDesc(`${cloud ? 'このモデルは名前が cloud で終わるため、外部（Ollama の cloud モデルなど）で実行されるものとして扱います。' : 'この接続先はこのパソコンの外です。'}同意するまで送信しません。接続先・サーバー・モデルを変えると同意し直しが必要です。`)
      .addToggle((toggle) => toggle.setValue(hasConsent('local', ai)).onChange(guarded(async (value: boolean) => {
        await save(withLocal((latest) => ({ consent: value ? consentFingerprint('local', latest) : null })));
        redraw();
      })));
  }

  // ---- judge: Jev (default) or none (§5.2) ----
  new Setting(containerEl)
    .setName('判定')
    .setDesc('生成した候補を、引用だけから答えられるか・1枚1知識かで判定します。未設定なら候補は「未判定」と表示します。')
    .addDropdown((dropdown) => dropdown
      .addOption('jev', 'Jev（外部サービス）')
      .addOption('none', '判定なし（決定的な検査だけ）')
      .setValue(ai.judge)
      .onChange(guarded(async (value: string) => {
        await save((latest) => ({ ...latest, judge: value === 'none' ? 'none' : 'jev' }));
        redraw();
      })));
  if (ai.judge !== 'jev') {
    // ---- timeouts: generation only when judge is none ----
    new Setting(containerEl)
      .setName('タイムアウト：生成')
      .setDesc('生成の最大待ち時間（秒）。既定は 60 秒、範囲は 1〜600 秒です。')
      .addText((text) => {
        const status = text.inputEl.parentElement!.parentElement!.createDiv({ cls: 'kioku-settings-status' });
        text.setPlaceholder('60').setValue(String(ai.timeouts.generateSeconds));
        text.inputEl.addEventListener('change', guarded(async () => {
          const value = text.inputEl.value.trim();
          if (!value) return;
          if (!/^\d+$/.test(value)) {
            status.setText('1〜600 秒の範囲で入力してください。');
            try {
              await lastSave;
            } catch {
              // Ignore previous save failure
            }
            const latest = section.current;
            text.setValue(String(latest.timeouts.generateSeconds));
            return;
          }
          const seconds = Number.parseInt(value, 10);
          if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 600) {
            await save((latest) => ({ ...latest, timeouts: { ...latest.timeouts, generateSeconds: seconds } }));
            status.setText('');
            text.setValue(String(seconds));
          } else {
            status.setText('1〜600 秒の範囲で入力してください。');
            try {
              await lastSave;
            } catch {
              // Ignore previous save failure
            }
            const latest = section.current;
            text.setValue(String(latest.timeouts.generateSeconds));
          }
        }));
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '600';
      });
    return;
  }
  const jev = ai.providers.jev;
  const withJev = (next: (latest: AiSettings) => Partial<AiSettings['providers']['jev']>) => (latest: AiSettings): AiSettings =>
    ({ ...latest, providers: { ...latest.providers, jev: { ...latest.providers.jev, ...next(latest) } } });
  new Setting(containerEl)
    .setName('Jev：API キー')
    .setDesc('キーは console.typesafe.ai/keys で発行します（無料枠はありません。入力 100 万トークンあたり $0.042、出力は無料）。主に英語で学習されたモデルで、日本語では精度が下がる可能性があります（実測前）。')
    .addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder(jev.apiKey ? `保存済み ${maskedKey(jev.apiKey)}` : 'API キー')
        .onChange(guarded(async (value: string) => {
          if (!value.trim()) return;
          await save(withJev(() => ({ apiKey: value.trim() })));
        }));
      text.inputEl.addEventListener('change', redrawAfterSave);
    })
    .addButton((button) => button.setButtonText('キーを削除').onClick(guarded(async () => {
      await save(withJev(() => ({ apiKey: '', consent: null })));
      redraw();
    })));
  new Setting(containerEl)
    .setName('Jev：モデル名')
    .setDesc('既定は jev-latest（小文字）。変更する必要がある場合だけ設定してください。')
    .addText((text) => {
      text.setPlaceholder('Jev-latest').setValue(jev.model).onChange(guarded(async (value: string) => {
        await save(withJev(() => ({ model: value.trim().toLowerCase() || 'jev-latest' })));
      }));
      text.inputEl.addEventListener('change', redrawAfterSave);
    });
  new Setting(containerEl)
    .setName(`外部への送信に同意する（${JEV_HOST}）`)
    .setDesc('候補ごとに、引用と前後の文脈（最大 1,500 字）と問い・答えを送ります。同意するまで送信しません。')
    .addToggle((toggle) => toggle.setValue(hasConsent('jev', ai)).onChange(guarded(async (value: boolean) => {
      await save(withJev((latest) => ({ consent: value ? consentFingerprint('jev', latest) : null })));
      redraw();
    })));

  // ---- timeouts ----
  new Setting(containerEl)
    .setName('タイムアウト：生成')
    .setDesc('生成の最大待ち時間（秒）。既定は 60 秒、範囲は 1〜600 秒です。')
    .addText((text) => {
      const status = text.inputEl.parentElement!.parentElement!.createDiv({ cls: 'kioku-settings-status' });
      text.setPlaceholder('60').setValue(String(ai.timeouts.generateSeconds));
      text.inputEl.addEventListener('change', guarded(async () => {
        const value = text.inputEl.value.trim();
        if (!value) return;
        if (!/^\d+$/.test(value)) {
          status.setText('1〜600 秒の範囲で入力してください。');
          try {
            await lastSave;
          } catch {
            // Ignore previous save failure
          }
          const latest = section.current;
          text.setValue(String(latest.timeouts.generateSeconds));
          return;
        }
        const seconds = Number.parseInt(value, 10);
        if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 600) {
          await save((latest) => ({ ...latest, timeouts: { ...latest.timeouts, generateSeconds: seconds } }));
          status.setText('');
          text.setValue(String(seconds));
        } else {
          status.setText('1〜600 秒の範囲で入力してください。');
          try {
            await lastSave;
          } catch {
            // Ignore previous save failure
          }
          const latest = section.current;
          text.setValue(String(latest.timeouts.generateSeconds));
        }
      }));
      text.inputEl.type = 'number';
      text.inputEl.min = '1';
      text.inputEl.max = '600';
    });
  new Setting(containerEl)
    .setName('タイムアウト：判定')
    .setDesc('判定の最大待ち時間（秒）。既定は 20 秒、範囲は 1〜600 秒です。')
    .addText((text) => {
      const status = text.inputEl.parentElement!.parentElement!.createDiv({ cls: 'kioku-settings-status' });
      text.setPlaceholder('20').setValue(String(ai.timeouts.judgeSeconds));
      text.inputEl.addEventListener('change', guarded(async () => {
        const value = text.inputEl.value.trim();
        if (!value) return;
        if (!/^\d+$/.test(value)) {
          status.setText('1〜600 秒の範囲で入力してください。');
          try {
            await lastSave;
          } catch {
            // Ignore previous save failure
          }
          const latest = section.current;
          text.setValue(String(latest.timeouts.judgeSeconds));
          return;
        }
        const seconds = Number.parseInt(value, 10);
        if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 600) {
          await save((latest) => ({ ...latest, timeouts: { ...latest.timeouts, judgeSeconds: seconds } }));
          status.setText('');
          text.setValue(String(seconds));
        } else {
          status.setText('1〜600 秒の範囲で入力してください。');
          try {
            await lastSave;
          } catch {
            // Ignore previous save failure
          }
          const latest = section.current;
          text.setValue(String(latest.timeouts.judgeSeconds));
        }
      }));
      text.inputEl.type = 'number';
      text.inputEl.min = '1';
      text.inputEl.max = '600';
    });
}
