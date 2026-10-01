# Kioku 製品計画

## 目的と確定事項

PC の Obsidian 内で、学習メモから候補を人が選び、採用カードを元メモ内に保存し、タグのデッキで間隔反復する。候補選択とデッキ選択は中央ポップアップ。回答を先に隠してアクティブリコールする。要件案は検討中であり、提案を確定要件と取り違えない。

## 実在する Linear inventory（2026-10-01 取得）

| 段階 | issue | この段階の範囲 |
| --- | --- | --- |
| M0 | LEV-274 | 起動可能な PC プラグイン、品質ゲート、専用 Vault、実機ハーネス |
| M1 | LEV-275（LEV-274 に blocked） | 明示 Q/A の候補確認・編集・採否・元メモ保存 |
| M2 | LEV-276（LEV-275 に blocked） | タグデッキ、問い→回答→評価、日程と履歴 |
| M3 | LEV-277（LEV-276 に blocked） | Jev の typed decision と別モデルによる要約 Q/A |
| M4 | LEV-278（LEV-277 に blocked） | IME、Undo/Redo、競合、重複、再起動、複数ビュー、ベータ準備 |

## M0 受入条件（LEV-274）

- ID `kioku`、名称 Kioku、desktop only。左 ribbon「フラッシュカード」とコマンドで中央の起動確認 modal を開く。
- 画面と README にカード機能未実装を明示する。ノートを読まず、書かず、fake deck を出さない。
- `npm ci` と `npm run check`。metadata、公式 lint、strict 型、意味のある test、production build、配布ハッシュ、CI、任意で非スキップの hook。
- 新規専用 Vault だけを prepare。update は既存 Markdown/config を変えず built plugin files だけを更新。preflight は containment、hash、ID/version/build、enablement を検査。
- docs、AGENTS、独立レビュー、再実行可能な native smoke。実機は enable → ribbon → modal → close → desktop restart 後の再確認。証跡なしに PASS と言わない。

## M1 受入条件（LEV-275）

- 開いているメモ・選択テキストから明示的 Q/A を抽出し、中央ポップアップで原文確認・編集・採用・破棄する。採用時だけ元メモへ保存する。
- 保存形式・安定 ID・再抽出の重複判定を先に設計する（`docs/architecture.md` の「M1 明示 Q/A」）。
- Excalidraw Data・コードブロックを除外し原文を保持する。開いたノートは Editor、閉じたノートは `Vault.process` で原文照合する。
- 日本語、同名見出し、Undo/Redo、外部変更、複数ビューを専用 Vault の実機で検証する。デッキ・復習・AI は作らない。

## M1 で決めたこと（LEV-275 の設計判断）

詳細と理由は `docs/architecture.md` の「M1 明示 Q/A」。

- **明示 Q/A 構文**：行頭の `Q:`/`問:`（全角コロン・全角 Ｑ 可）から始まり `A:`/`答:` を含むブロック。空行・見出し・次の問いで終わる。
- **保存構文と安定 ID**：元ブロック最終行末へ Obsidian block ID ` ^kioku-<ランダム10文字>` を追記するだけで原文は変えない。ポップアップで編集した場合は直後に `%%kioku-edit:<id> … %%` の編集記録を足す。ID は内容ハッシュでなくランダム。
- **Excalidraw 本文範囲**：Excalidraw ノートは `# Excalidraw Data` 等の見出し以降と `%%` 内をすべて除外する。
- **重複**：`^kioku-` ID 付きブロックは採用済み。ID 重複は採用不可、採用済みと同内容の候補は警告のみ。
- **見送り**：M1 の「破棄」はポップアップから外すだけでノートに記録しない（再抽出で再び候補になる）。永続的な見送り記録は未決定のまま。

## 未決定（M1 時点でも決めていない）

編集後の履歴（M2 の復習履歴との関係）、永続的な見送り記録、タグ適用範囲・親子/複数デッキ、Due/New/Total、FSRS/SM-2 と日付境界、履歴保存場所、既存 Spaced Repetition 互換、AI 認証/モデル/外部送信、PDF/OCR、モバイル、Cloze、双方向カード。コピー入力の保存先も未決定。
