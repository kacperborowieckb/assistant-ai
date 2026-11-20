import type { ModelMessage } from "ai";

import type { Usage } from "./usage-ledger.ts";

export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: string;
  readonly output: string;
  readonly failed: boolean;
}

export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: string;
}

export interface ModelStep {
  readonly usage: Usage;
  readonly toolCalls: readonly ModelToolCall[];
  readonly responseMessages: readonly ModelMessage[];
}
