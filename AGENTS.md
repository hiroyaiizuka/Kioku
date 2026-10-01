# Kioku 開発ハーネス

- 英語で考え、日本語で報告する。
- 製品要件は `docs/product-plan.md`、設計は `docs/architecture.md`、検証は `docs/harness.md`、チケット運用は `docs/linear-workflow.md`、コマンドは `docs/development.md`。README は利用者向け。
- 実装前に対象 Linear issue の受入条件と依存を確認する。1 チケットを完了させてから次へ進む。
- M0 では起動確認だけ。カード、デッキ、復習、AI、ノート読み書きを実装済みと表現しない。
- `src/main.ts` は登録とライフサイクル、UI は `src/ui/`。製品 runtime は公開 Obsidian API とブラウザ互換コードだけを使う。Node/Electron は tooling のみ。
- 本番 Vault を自動操作しない。`harness:prepare` はプロジェクト直下の新規 `test-vault/` だけ、更新は `harness:update` だけを使う。
- UI/保存経路の変更は、専用 Vault の実機で確認して `artifacts/` に証跡を残す。モックや preflight の成功を実機成功と呼ばない。
- 完了前に `npm run check` と変更全体の独立レビューを実行する。修正後は check とレビューをやり直す。
- `dist/`、`test-vault/`、`artifacts/`、`node_modules/` をコミットしない。plugin ID は `kioku`、名称は `Kioku`。Mappy の ID・名称を継承しない。
