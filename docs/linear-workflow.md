# Linear とワーカーの手順

## 選定

Kioku project の非 archived issue と relation を毎回すべて取得し、blocked でない最も早い milestone/priority を選ぶ。2026-10-01 inventory では LEV-274 (M0, High, blocker なし) だけが開始可能で、LEV-275→276→277→278 は直列依存。Ready は開始可能の意味で、Done ではない。

## 1 issue の流れ

1. issue UUID/URL、全文、受入・完了条件、requirements document を読む。Linear status の外部更新は親だけ。
2. 1 issue/1 worker/1 Git worktree。既存の担当・worktree を確認し、プライマリーを `main` のまま保つ。ワーカーへの引継ぎは push 済みのチケットブランチを使う。未コミットのローカル状態が必要な場合だけ共有 VM で直列実行する。
3. 再現/受入テストを先に用意し、実装。README の利用者向け説明と docs を分ける。
4. `npm ci` と `npm run check`。結果、変更ファイル、未実施事項を渡す。
5. 別担当が `.claude/skills/review-check/SKILL.md` に従い source/scripts/tests/CI/docs/manifest/lock の全変更を独立レビュー。範囲は `origin/main...HEAD`（別の base から切った場合はその base）を明示する。指摘は同じ issue で直し、check と独立レビューを再実行する。実行していない `/code-review` を実行済みと書かない。
6. 親が外部書き込み、repository/PR/Linear を扱う。PR が In Review になるまでは Done にせず、merge 前に Done にしない。
7. testing agent が専用 Vault の Obsidian desktop で enable→ribbon→中央 modal→close→restart 後の再確認を行い、実際の証跡を artifacts に残す。
8. 親だけが Slack に PR/check/review/実機証跡と未検証事項を正確に報告する。

review、実機、PR、Slack のどれかが未実施ならそのまま limitations として止める。mock、build、preflight の PASS で代用しない。
