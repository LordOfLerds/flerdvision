export type AiProviderMode =
  | "disabled"
  | "claude_subscription_cli"
  | "codex_chatgpt_cli"
  | "anthropic_api"
  | "openai_api";

export interface AiProviderConfig {
  mode: AiProviderMode;
  enabled: boolean;
  wrapperCommand?: string;
  wrapperArgs?: readonly string[];
  timeoutMs?: number;
}

export interface AiProviderPreflight {
  mode: AiProviderMode;
  enabled: boolean;
  ready: boolean;
  checks: readonly { name: string; passed: boolean; detail: string }[];
}
