/** Server authority; browser drafts/selection/scroll positions are separate. */
export type Provider = 'codex' | 'claude' | 'dsh' | 'shell';
export interface Capabilities { send?: boolean; steer?: boolean; interrupt?: boolean; approval?: boolean; commands?: boolean; [name: string]: boolean | undefined }
export interface Approval { id: string; type: string; turnId?: string; requestId?: string; status?: string }
export interface Delivery { message_id: string; submission_id?: string; turn_id?: string; state: string; error?: string }
export interface Item { id: string; type: string; text?: string; status?: string }
export interface Turn { id: string; status: string; items: Item[] }
export interface Session { id: string; root: string; type: 'native' | 'app-server' | 'tmux' | 'pty'; kind: Provider; status: string; executor_id?: string; capabilities?: Capabilities }
export interface PaneView { project: string; session: string | null; draft: string; scrollTop: number; selectedTab: 'conversation' | 'trace' }
export interface StateSyncFrame { type: 'state_sync'; protocol: 1; mode: 'snapshot' | 'patch'; channel: 'codex' | 'native'; root: string; sessionId: string; executorId: string; generation: string; revision: number; baseRevision?: number; state?: unknown; operations?: unknown[] }
