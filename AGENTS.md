# Kioku 開発ハーネス

- 英語で考え、日本語で報告する。
- 製品要件は `docs/product-plan.md`、設計は `docs/architecture.md`、検証は `docs/harness.md`、チケット運用は `docs/linear-workflow.md`、コマンドは `docs/development.md`。README は利用者向け。
- 実装前に対象 Linear issue の受入条件と依存を確認する。1 チケットを完了させてから次へ進む。
- M0 では起動確認だけ。カード、デッキ、復習、AI、ノート読み書きを実装済みと表現しない。
- M1（LEV-275）は明示 Q/A の候補確認・編集・採用・元メモ保存まで。デッキ、復習、AI を実装済みと表現しない。起動時はノートを読み書きせず、読み取りは明示操作時、書き込みは採用時だけ。
- `src/main.ts` は登録とライフサイクル、UI は `src/ui/`。製品 runtime は公開 Obsidian API とブラウザ互換コードだけを使う。Node/Electron は tooling のみ。
- 本番 Vault を自動操作しない。`harness:prepare` はプロジェクト直下の新規の専用 Vault（既定 `test-vault/`、`KIOKU_TEST_VAULT_NAME="Kioku テスト用"` のときは `Kioku テスト用/`。この2つだけ）だけ、更新は `harness:update` だけを使う。
- 利用者の Obsidian は開いたままにする。実機は `harness:launch`/`harness:quit` の専用インスタンスだけを使い、Obsidian をアプリ名で終了させない（`osascript quit`、`pkill`/`killall` 禁止）。
- エージェントは利用者の明示的な同意なしに `KIOKU_ALLOW_CLI_SOCKET_TAKEOVER` を設定しない（利用者の Obsidian CLI socket を奪い、quit 後も再起動まで CLI が使えなくなる）。
- UI/保存経路の変更は、専用 Vault の実機で確認して `artifacts/` に証跡を残す。モックや preflight の成功を実機成功と呼ばない。
- 完了前に `npm run check` と変更全体の独立レビューを実行する。修正後は check とレビューをやり直す。
- `dist/`、`test-vault/`、`Kioku テスト用/`、`artifacts/`、`node_modules/` をコミットしない。plugin ID は `kioku`、名称は `Kioku`。Mappy の ID・名称を継承しない。

## 作業と最終承認

- プライマリーは `main` の司令塔として維持し、実装・規約修正は専用 worktree で行う。
- merge の判定対象は最終 HEAD とする。同じ HEAD の CI 成功、変更全体の独立レビュー結果、既存規約で必要な専用 Obsidian 実機確認の結果・ビルド識別情報・証跡を揃える。HEAD が変わったら判定し直し、必要な検証を再実行する。
- 実機確認が不要な変更は理由を明記する。未実施・失敗・別ビルドの証跡を合格扱いしない。
- 最終的な PR の取り込みは本人が判断して行う。エージェントは PR の merge・auto-merge の有効化を行わない。この条件は、既存手順で定めた作業ブランチへの同期（`main` から `feature/ai` への取り込みなど）を禁止するものではない。
- レビュー回数の上限や再レビュー省略条件は、未レビューの最終 HEAD を合格扱いする根拠にしない。上限に達して必要条件が揃わない場合は未達として本人に報告する。
