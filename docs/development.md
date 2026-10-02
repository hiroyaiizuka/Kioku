# Kioku の開発

Node.js は `.nvmrc` の **22.22.3** を使う。tooling の direct dependency は exact stable version で lock する。runtime dependency は M2 から ts-fsrs 5.4.2 の1つだけ（exact pin、`main.js` に bundle、MIT 表示を `main.js` 先頭に保持）。版を上げるときは `scripts/lib/build.mjs` の `runtimeDependencies`、`src/review/scheduler.ts` の `SCHEDULER_ID`、FSRS の単体テスト（間隔）を同時に見直し、記録に残す。

```sh
nvm use
npm ci
npm run check
```

主なコマンド:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run package
npm run harness:prepare    # 初回、新規専用 Vault のみ
npm run harness:update     # Obsidian を閉じ、4配布物だけ更新
npm run harness:preflight
KIOKU_CONFIRM_VAULT_CLOSED=1 npm run harness:e2e:smoke -- baseline # 実機担当、enable/startup 前。出力された ID を保持
KIOKU_BASELINE_ID="表示されたUUID" npm run harness:e2e:smoke # 実機担当、running native Obsidian + loopback CDP。restart 後も同じ ID
npm run hooks:install      # Git 作成後の任意 hook。check を skip しない
```

生成物は `dist/kioku/`、試用 Vault は `test-vault/`、実行証跡は `artifacts/`。すべて git 管理外。`npm run check` は実機を起動せず、実機成功を主張しない。プライマリーは `main` に置き、チケットごとに独立した Git worktree で作業する。プロジェクト内の `.claude/worktrees/` に作られた worktree は Git 管理外で、primary checkout の lint/test 対象から除外する（build input と validate は `src/` と固定ファイル一覧だけを読むため影響しない）。main への直接 push は行わず、変更は PR でレビューする。

dependency 更新では Node/Obsidian の互換、公式 lint peer、lock、audit を確認する。Obsidian API 型は `manifest.minAppVersion` と同じ。Node security advisory が tooling の local-only test server/型 package にだけある場合も、残る理由と到達可能性をレビューへ記録する。
