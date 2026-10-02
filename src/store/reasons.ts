/**
 * User-facing texts for M2 storage, in the style of src/cards/reasons.ts: a reason states the cause
 * only; prefixes such as 「評価を保存できませんでした」 are added once by the composing helpers.
 */
export const STORE_REASONS = {
  readOnly: '学習データが読み取り専用のため評価を保存できません。デッキ選択の注記を確認してください。',
  unconfirmed: '記録ファイルへの追記を確認できませんでした。',
  stateUpdateFailed: 'Kioku：日程ファイルの更新に失敗しました。次に開いたときに記録から反映します。',
  closedWhileSaving: 'Kioku：保存中に閉じた評価を保存できませんでした。次に開いたとき、その評価が反映されているか確認してください。',
  truncatedLost: 'この行の評価は失われます（他の記録はそのまま残ります）。',
} as const;

export const stateUnreadable = (path: string, detail: string): string =>
  `日程ファイル ${path} を読めません（${detail}）。上書きしないよう読み取り専用にしています。README の復旧手順を参照してください。`;
export const stateUnknownSchema = (path: string, version: string): string =>
  `日程ファイル ${path} は新しい版の Kioku の形式（schemaVersion ${version}）です。読み取り専用にしています。`;
export const historyCorrupt = (path: string, line: number): string =>
  `記録ファイル ${path} の ${line} 行目が壊れています。読み取り専用にしています。README の復旧手順を参照してください。`;
export const historyUnknownVersion = (path: string, line: number, version: string): string =>
  `記録ファイル ${path} の ${line} 行目は新しい版の Kioku の形式（v${version}）です。読み取り専用にしています。`;
export const historyTruncated = (path: string, line: number): string =>
  `記録ファイル ${path} の最終行（${line} 行目）が途中で切れています。読み取り専用にしています。`;
export const fileUnreadable = (path: string, detail: string): string =>
  `${path} を読めません（${detail}）。読み取り専用にしています。`;
export const historyMissing = (path: string): string =>
  `記録ファイル ${path} が見つからないか、日程ファイルが反映済みとしている行より短くなっています。日程を失わないよう読み取り専用にしています。README の復旧手順を参照してください。`;
export const invalidEvent = '評価の記録を作れませんでした（カード ID が不正です）。';
export const saveFailed = (detail: string): string => `記録ファイルに書き込めませんでした（${detail}）。`;

export const notIndexed = (count: number): string => `索引中のノート ${count} 件（あとで再読み込み）。まだ Obsidian のメタデータが作られていないため、今回は数えていません。`;
export const ratingNotSaved = (reason: string): string => `評価を保存できませんでした：${reason}`;
export const folderChangeRefused = (oldFolder: string): string =>
  `古いフォルダ（${oldFolder}）にデータがあります。移動してから変更してください。`;
