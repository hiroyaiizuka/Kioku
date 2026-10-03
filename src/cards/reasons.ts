/**
 * Every user-facing reason Kioku can show when an adoption does not happen or cannot be
 * confirmed, and how they are composed into Notice / inline text. Reasons describe the cause
 * only; the composed prefix (「保存しませんでした」 / 「採用を確認できませんでした」) is added once
 * by `refusal*` / `lost*`, so a reason must never contain those phrases itself.
 */
export const REASONS = {
  sourceChanged: '原文が抽出後に変更されています。もう一度抽出してください。',
  ambiguous: '同じ原文が複数あり、位置を特定できません（外部で変更された可能性があります）。',
  alreadyAdopted: 'この問い・答えは既に採用済みです。',
  foreignBlockId: '既存の block ID があるため採用できません。',
  emptyQuestion: '問いが空です。',
  emptyAnswer: '答えが空です。',
  editPercent: '「%%」は編集記録に含められません。',
  editCardId: '「^kioku-」は編集記録に含められません。',
  editFence: 'コードブロックの区切り（``` や ~~~）は編集記録に含められません。',
  editMath: '「$$」は編集記録に含められません。',
  editHtmlComment: 'HTML コメントは編集記録に含められません。',
  editStructure: '空行・見出し・行頭の問い/答えの印（Q: や A: など）を含む編集は保存できません。',
  quoteRecord: '引用を記録できないため採用できません（引用に空行・「%%」・「$$」・HTML コメント・コードブロックの区切り・見出し・行頭の問い/答えの印・「^kioku-」のどれかが含まれます）。',
  unconfirmedWrite: '書き込みを確認できませんでした。ノートを開いて ID が付いたか確認してください。',
  lostAfterWrite: '保存後に ID が見つかりません。別の画面の保存で上書きされた可能性があります。もう一度抽出してください。',
} as const;

export const writeFailed = (detail: string): string => `ノートを書き換えられませんでした（${detail}）。`;
export const canvasEmbeds = (canvasPath: string): string =>
  `このノートは開いている Canvas（${canvasPath}）に埋め込まれています。Canvas を閉じてから採用してください。`;
export const canvasUnreadable = (canvasPath: string, detail: string): string =>
  `開いている Canvas（${canvasPath}）を確認できません（${detail}）。Canvas を閉じてから採用してください。`;

/** Adoption refused before or during the write: nothing (confirmed) was saved. */
export const refusalNotice = (reason: string): string => `Kioku：保存しませんでした。${reason}`;
export const refusalInline = (reason: string): string => `保存しませんでした：${reason}`;
/** Written, but the ID could not be confirmed on disk. */
export const lostNotice = (reason: string): string => `Kioku：採用を確認できませんでした。${reason}`;
export const lostInline = (reason: string): string => `採用を確認できませんでした：${reason}`;
export const PENDING_CLOSED_NOTICE = 'Kioku：保存の確認前に閉じました。もう一度抽出して採用済みか確認してください。';
