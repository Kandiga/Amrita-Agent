// Shared types for the whole platform. Keep this file dependency-free.

// ---------- Chat & agent ----------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  /** Stringified result content handed back to the model. */
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** Unix ms. */
  at?: number;
}

/** Streamed events emitted by the agent loop; channels render these. */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; result: ToolResult }
  | { type: 'lane'; lane: LaneEvent }
  | { type: 'turn-end'; message: ChatMessage }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'complete' | 'max-turns' | 'aborted' };

// ---------- Lanes (connector preview/console panels) ----------

export type LaneKind = 'console' | 'preview';

export type LaneEvent =
  | { kind: 'open'; laneId: string; lane: LaneKind; title: string; url?: string }
  | { kind: 'output'; laneId: string; text: string }
  | { kind: 'status'; laneId: string; status: string }
  | { kind: 'close'; laneId: string };

// ---------- Tools ----------

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Toolset this tool belongs to (permission group). */
  toolset: string;
}

export interface ToolContext {
  projectSlug: string | null;
  sessionId: string;
  channel: string;
  /** Channel-level chat id (e.g. Telegram chat) — null for web/cli. */
  chatId: string | null;
  /** Project working directory, when bound to a project that has one. */
  workingDir: string | null;
  /** Emit a lane event (connectors use this). */
  emitLane: (e: LaneEvent) => void;
  /** Abort signal for long-running tools. */
  signal: AbortSignal;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>;

export interface RegisteredTool extends ToolSpec {
  handler: ToolHandler;
}

// ---------- Providers ----------

export interface ProviderProfile {
  id: string;
  label: string;
  /** 'anthropic' | 'openai-compat' wire format. */
  api: 'anthropic' | 'openai-compat';
  baseUrl: string;
  /** Name of the env var holding the key (looked up in secrets). */
  keyEnv: string | null;
  authMode: 'api_key' | 'local_endpoint';
  defaultModel: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
}

export type ProviderStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'stop'; reason: 'end' | 'tool-use' | 'max-tokens' }
  | { type: 'error'; message: string };

export interface Provider {
  profile: ProviderProfile;
  chat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent>;
}

// ---------- Projects, sessions, bindings ----------

export interface Project {
  slug: string;
  name: string;
  createdAt: number;
  workingDir: string | null;
  defaultModel: string | null;
  enabledConnectors: string[];
}

export interface Session {
  id: string;
  projectSlug: string | null; // null = "main Amrita"
  channelOrigin: string;
  createdAt: number;
  lastActiveAt: number;
  title: string | null;
  parentSessionId: string | null;
}

export interface Binding {
  channel: string;
  chatId: string;
  projectSlug: string | null;
  sessionId: string;
  updatedAt: number;
}

// ---------- Channel adapters ----------

export interface InboundMessage {
  channel: string;
  chatId: string;
  userId: string;
  text: string;
}

export interface OutboundButton {
  label: string;
  /** Callback data routed back as a command. */
  action: string;
}

export interface OutboundMessage {
  text: string;
  markdown?: boolean;
  buttons?: OutboundButton[][];
}

export interface ChannelAdapter {
  name: string;
  capabilities: { buttons: boolean; streaming: boolean; lanes: boolean };
  start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<void>;
}

// ---------- Config ----------

export interface AmritaConfig {
  model: { provider: string; model: string; maxTokens: number };
  auxiliary: { provider: string; model: string } | null;
  fallback: { provider: string; model: string }[];
  providers: Record<string, Partial<ProviderProfile>>;
  channels: { telegram: { enabled: boolean; allowedUserIds: number[] } };
  daemon: { host: string; port: number; publicUrl: string | null };
  agent: { maxTurns: number; contextTokenBudget: number };
  toolsets: { disabled: string[] };
  connectors: { claudeCode: { enabled: boolean; autonomy: 'ask' | 'auto' }; openDesign: { enabled: boolean; baseUrl: string } };
  promptEngineer: { enabled: boolean };
}

// ---------- Cron ----------

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // 5-field cron
  prompt: string;
  projectSlug: string | null;
  delivery: { channel: string; chatId: string } | null;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
}
