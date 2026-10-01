---
name: review-check
description: Kioku の変更全体を独立レビューし、品質ゲートと証跡の主張を照合する
---

# Kioku independent review/check

実装担当と別の reviewer が行う。git history/remote が無ければ架空の diff command を実行せず、Kioku 内の全 file inventory を対象にする。

1. LEV-274 全受入条件と `docs/product-plan.md` を照合。M1+ のカード/保存/AI/復習を作らず、未実装表示が UI/README にあるか。
2. `src/`、manifest/styles、package/lock、scripts/tests、CI/hook、docs/AGENTS、ignore を全件読む。`src/main.ts` は登録/lifecycle、UI は `src/ui`、runtime は公開 Obsidian API/browser code のみか。
3. path containment の bypass（symlink parent/file、hard link、既存 Vault、任意引数）、部分更新、config/Markdown 上書き、hash の自己申告/stale build、disabled/extra plugin を adversarial に確認する。
4. test が実装を外すと失敗するか確認する。modal は実 source を bundle した test、tooling は実 file bytes/CLI exit を扱うか。広い lint suppression・skip・snapshot だけの test は不可。
5. clean install 相当で `npm ci && npm run check`。check が validate/lint/type/test/production build/package を全部非スキップで呼ぶか。CI と optional hook も同じ gate か。
6. `artifacts/` の証跡は actual command/build ID/timestamp/error と一致するか。preflight/mock を native PASS と呼ばない。実機未実施なら明記する。
7. severity を問わず file:line、操作×対象、影響、再現、修正案を報告する。修正後は check と独立 review を最初からやり直す。見送る指摘は親が PR に理由を書く。

レビュー自身が Obsidian を起動しない場合、enable/ribbon/modal/close/restart は「未検証」。GitHub/PR/Linear/Slack も親以外は書き込まない。
