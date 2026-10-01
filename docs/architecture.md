# Kioku アーキテクチャ

## M0 runtime

`src/main.ts` は plugin lifecycle、ribbon と command の登録、modal の所有だけを行う。`src/ui/startup-modal.ts` は公開 `Modal` API で scoped class の中央 modal を描く。ノート、Vault、workspace state、ネットワーク、Node/Electron API、他プラグイン API へ触れない。runtime dependency はなく、`obsidian` は host external である。

同じ `StartupModal` instance を再利用し、unload 時に閉じる。表示ごとに内容を再構築し、close で内容を片付ける。画面には version と build ID を data attribute と文字列で出し、実機 smoke が今の配布物を識別できる。カード機能未実装を UI 自身が明示する。

## Build identity と配布物

production esbuild は browser/CJS/ES2021、external は `obsidian` だけ。build ID は `src/`、manifest、package/lock、Node/TS/build script、styles の SHA-256 一覧から導く。`dist/kioku/` は `main.js`、`manifest.json`、`styles.css`、`build-info.json` の4ファイルだけ。build-info は入力、3 plugin file の hash、external import を記録する。自分自身の hash は自己参照になるため持たず、preflight は build-info bytes を dist と installed で比較する。

## Tooling trust boundary

Node は `scripts/` とテストだけ。全 CLI は引数で任意 path を受けず、real project root からの実行を要求する。書き込み先の全 existing path component について project containment、symlink、file hard link、型を確認し、一時ファイルから atomic rename する。これは誤操作/既存 link に対する防御で、同一ユーザーの敵対的 concurrent filesystem mutation まで完全に防ぐものではない。Vault 更新中は専用インスタンスを `harness:quit` で止める。プロジェクト外へ触れるのは、利用者の app-support にある `obsidian-*.asar` の読み取り、Obsidian 実行ファイルの専用 profile での起動、専用 `--user-data-dir` を command line に持つことを `ps` で確認した記録 PID への SIGTERM だけで、プロセスを名前で探したり終了したりしない。起動された Obsidian 自身は通常起動と同様に利用者の login keychain 項目と `~/.obsidian-cli.sock`（macOS では HOME 固定）を使う（`docs/harness.md`）。

`harness:prepare` は Vault が少しでも存在すれば拒否する。生成 marker が完全一致する Vault のみ update/preflight できる。update は4配布物だけを atomic update し、Markdown と `.obsidian/community-plugins.json` を含む既存 config を変更しない。preflight は enablement が厳密に `["kioku"]` であることも確認する。
