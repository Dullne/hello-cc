import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';

export interface DshCollaborationConfig {
  /** Bounded model context, 2048-64000 characters. Default 16000. */
  maxContextChars?: number;
  /** Bounded lossless-JSON tool presentation, 2048-64000 characters. Default 16000. */
  maxToolChars?: number;
}
export const name: 'hello-cc-dsh-collaboration';
export const inject: readonly ['agents', 'tools', 'sessions'];
export const DSH_CORDIS_VERSION: '0.2.0-rc.2';
export function checkDshRuntime(anchor?: string): void;
export function apply(ctx: Context, config?: DshCollaborationConfig): void;
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hello-cc': { readonly kind: 'hello-cc' } & ContextFormed;
  }
}
