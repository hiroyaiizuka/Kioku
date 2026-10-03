// User-facing texts for AI failures and guidance (docs/m3-design.md §8, §10). A text never contains
// an API key, a request header or a response body: only the provider, its host and an HTTP status.
import type { ProviderFailure } from './types';

export interface FailureContext {
  /** e.g. 「Jev」 or 「Ollama（qwen3:8b）」. */
  readonly label: string;
  /** Host (external) or base URL (local) shown in connection messages. */
  readonly where: string;
  readonly external: boolean;
  /** Extra hint for authentication failures (where to get a key). */
  readonly authHint?: string;
}

export const AI_GUIDANCE = {
  disabled: 'AI が未設定のため、ノートに書いた問い・答えだけを表示しています。設定 → Kioku → AI で、ローカルの AI（Ollama など）を設定できます。',
  noModel: 'AI の生成モデル名が未設定のため、AI で候補を作れません。設定 → Kioku → AI で、ローカルのサーバー（Ollama など）で使うモデル名を入力してください。',
  excalidraw: 'Excalidraw のノートでは AI で候補を作りません（描画データを壊さないため）。ノートに書いた問い・答えは使えます。',
  empty: '送る本文がありません（コードブロック・コメント・数式・frontmatter は送りません）。',
  waiting: '前の要求の完了を待っています（応答しないサーバーへの要求が残っています）。キャンセルできます。',
} as const;

export const tooLong = (chars: number, limit: number): string =>
  `送る本文が ${chars.toLocaleString('en-US')} 字あり、1回の上限 ${limit.toLocaleString('en-US')} 字を超えています。範囲を選択してから実行してください。`;

export const consentRequired = (label: string, host: string): string =>
  `${label}（${host}）への外部送信に同意していません。設定 → Kioku → AI で送信先とプライバシーを確認してから同意してください。`;

export function failureMessage(failure: ProviderFailure, context: FailureContext): string {
  const { label, where } = context;
  switch (failure.kind) {
    case 'unconfigured': return `${label} が未設定です。`;
    case 'consent-required': return consentRequired(label, where);
    case 'auth': return `API キーが無効か期限切れです（${label}、${failure.detail}）。${context.authHint ?? ''}`;
    case 'quota': return `利用枠が不足しています（${label}、${failure.detail}）。`;
    case 'rate-limited': return `要求が多すぎるため断られました（${label}、${failure.detail}）。少し待ってからもう一度試してください。`;
    case 'overloaded': return `サービスが混み合っています（${label}、${failure.detail}）。少し待ってからもう一度試してください。`;
    case 'invalid-request':
      return failure.detail === 'HTTP 404'
        ? `モデルか接続先が見つかりません（${label}、${failure.detail}）。モデル名とサーバーの種類を確認してください。`
        : `要求が受け付けられませんでした（${label}、${failure.detail}）。本文が長すぎる場合は範囲を選んでください。`;
    case 'invalid-response': return `AI の応答を読み取れませんでした（${label}）。`;
    case 'network':
      return context.external ? `${where} に接続できません。`
        : `${where} に接続できません。Ollama などのサーバーが起動しているか確認してください。`;
    case 'timeout': return `時間内に応答がありませんでした（${label}、${failure.detail}）。`;
    case 'cancelled': return 'キャンセルしました。';
    case 'server': return `サービス側のエラーです（${label}、${failure.detail}）。`;
  }
}

/** Short reason for an 「未判定（…）」 badge. */
export function unjudgedWhy(failure: ProviderFailure): string {
  switch (failure.kind) {
    case 'cancelled': return 'キャンセル';
    case 'timeout': return 'タイムアウト';
    case 'auth': return '認証失敗';
    case 'network': return '接続失敗';
    case 'rate-limited':
    case 'overloaded': return '混雑';
    case 'quota': return '利用枠不足';
    default: return '判定失敗';
  }
}
