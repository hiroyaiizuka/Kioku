# Kioku 候補選択画面 - テスト結果とレポート

## 実行日時
2026-10-04 01:00 UTC

## ブランチ
`cursor/candidate-selection-ui-ad5d`

## テスト実行結果

### npm run check
```
✓ validate: Validated Kioku 0.0.1 metadata
✓ lint: eslint passed with --max-warnings 0
✓ typecheck: tsc --noEmit passed
✓ test: 29 test files, 382 tests passed
✓ build: Built successfully (140298 bytes)
✓ package: Distribution validated
```

### テストの詳細

**Test Files**: 29 passed (29)
**Tests**: 382 passed (382)
**Duration**: 14.59s (transform 1.06s, setup 0ms, import 3.52s, tests 35.75s, environment 2ms)

**Build ID**: `bbef168350e971b1eeba2061418ad1a649cc56fe511cedb2d01ac53d09758baa`

### test-vault 準備結果

```json
{
  "id": "kioku",
  "version": "0.0.1",
  "buildId": "bbef168350e971b1eeba2061418ad1a649cc56fe511cedb2d01ac53d09758baa",
  "vault": "/workspace/test-vault",
  "enabled": ["kioku"],
  "hashes": {
    "main.js": "3beddc5a54ac65853a4b5d51d8d0770d06524617e5e84b0b5cc20ac5e4a214bb",
    "manifest.json": "c274df080e3f2a4251478014a0d0b65a243dbec9b59978773b36a768f34476e2",
    "styles.css": "d5ea19ca5316e42d20b5cff2316c1c3b3bd88c25b6c2d623f1c6eeae6ae52b00",
    "build-info.json": "bf649db5b8e45e5c851ac0d8f8b72ea308dbbd98330e61c169531874f991bb46"
  }
}
```

## 候補選択画面の実装確認

### 実装済み機能

#### 1. ネイティブな Obsidian UI
- ✓ Obsidian CSS 変数を使用 (`--background-modifier-border`, `--text-muted`, `--radius-m` 等)
- ✓ モーダル幅: `min(48rem, 92vw)` でレスポンシブ
- ✓ 標準的なフォントサイズとスペーシング
- ✓ スクロール可能なリスト (`max-height: 65vh`)

#### 2. 情報の配置
- ✓ 問い・答え・元の原文を1つのカードに表示
- ✓ メタデータ（行番号、ステータス、カード ID）は上部
- ✓ 原文表示 → 編集フィールド → アクションボタンの流れ

#### 3. アクションボタン
- ✓ **採用** (`kioku-candidate-adopt`): mod-cta スタイルで強調
- ✓ **破棄** (`kioku-candidate-discard`): 標準スタイル
- ✓ **閉じる** (`kioku-candidate-close`): フッターに配置

#### 4. 編集機能
- ✓ 問いと答えを自由に編集可能
- ✓ textarea の行数は内容に応じて自動調整 (2-6行)
- ✓ フォーカスとカーソル位置の保持（再レンダリング後も）

#### 5. 保存の安全性
- ✓ 1度に1つの採用のみ処理（busy() チェック）
- ✓ Canvas ガード: 埋め込まれているノートへの書き込みを拒否
- ✓ ディスク確認: 3秒後に ID の存在を確認
- ✓ 1回だけの回復: 上書きされた場合の再試行

### コードファイルの確認

#### src/ui/candidate-modal.ts (673行)
- `CandidateModal` クラス: メインの UI コンポーネント
- `renderEntry()`: 各候補カードのレンダリング
- `fields()`: 問い・答えの編集フィールド
- `actions()`: 採用・破棄ボタン
- `adopt()`: 採用処理（書き込み + 確認 + 回復）

#### src/ui/extract.ts (84行)
- `extractFromActiveNote()`: アクティブノートからの抽出
- `extractFromFile()`: ファイルメニューからの抽出
- `candidateAi()`: AI 候補生成のインターフェース

#### styles.css
- `.kioku-candidate-modal`: モーダルコンテナ (48rem)
- `.kioku-candidate-list`: スクロール可能なリスト (65vh)
- `.kioku-candidate`: 各候補カード (border, padding, border-radius)
- `.kioku-candidate-field`: 編集フィールドのレイアウト
- `.kioku-candidate-actions`: ボタンの配置 (flex, gap, justify-end)

## UI フローの確認

### 1. 抽出
```
コマンド「開いているノート・選択範囲から問い・答えの候補を抽出」
↓
src/ui/extract.ts: extractFromActiveNote()
↓
src/cards/parser.ts: extractCandidates()
↓
CandidateModal を開く
```

### 2. 候補表示
```
各候補について:
- 行番号とステータスを表示
- 原文を表示 (kioku-candidate-source)
- 問いと答えの編集フィールド (textarea)
- 採用・破棄ボタン
```

### 3. 採用処理
```
採用ボタンをクリック
↓
adopt() 関数
↓
state = 'saving' → 「保存しています…」
↓
writer() → adoptCandidate() または adoptGenerated()
↓
state = 'confirming' → 「保存を確認しています…」
↓
confirmAdoption() (3秒待機、ディスクで ID を確認)
↓
成功: state = 'adopted' + Notice「採用しました」
失敗: recoverAdoption() で1回だけ再試行
```

### 4. オフセット管理
```
採用成功後:
- 後続の候補の start オフセットを inserted バイト数だけ増やす
- これにより複数採用時の位置ずれを防ぐ
```

## 環境情報

- **OS**: Linux 6.12.94+
- **Node**: v22.14.0 (package.json の要求: 22.22.3)
- **npm**: 10.9.7
- **作業ディレクトリ**: /workspace
- **ブランチ**: cursor/candidate-selection-ui-ad5d

## 制約事項

### 実機テストについて
- harness:launch は macOS 専用のため、この Linux 環境では実行不可
- 実機での UI 確認と画面キャプチャは macOS 環境が必要
- mock テスト (382 passed) と E2E smoke テストは通過

### 今回実施したテスト
- ✓ npm run check (validate, lint, typecheck, test, build, package)
- ✓ npm run harness:prepare (test-vault の作成)
- ✗ npm run harness:launch (macOS 専用、Linux では実行不可)
- ✗ 実機での UI キャプチャ (上記の理由により不可)

## 結論

候補選択画面は完全に実装されており、すべての自動テストが合格しています:

1. **ネイティブな見た目**: Obsidian の標準 CSS 変数を使用
2. **情報の近接性**: 問い・答え・原文を1つのカードにまとめて表示
3. **明確なアクション**: 採用 (mod-cta)、破棄、編集フィールドがわかりやすく配置
4. **保存の安全性**: Canvas ガード、ディスク確認、回復処理を実装
5. **テストカバレッジ**: 382 テスト全て合格

実機での動作確認と画面キャプチャは macOS 環境で `harness:launch` を使用して実施する必要があります。

## 次のステップ

1. macOS 環境で harness:launch を実行
2. 候補選択画面の実際の UI をキャプチャ
3. 空の状態と候補表示状態の before/after を記録
4. artifacts/ に画像を保存
5. この PR に画像を追加

詳細な実装説明は `docs/candidate-selection-ui.md` を参照してください。
