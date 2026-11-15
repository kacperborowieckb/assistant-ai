import type { Usage } from "./usage-ledger.ts";

export interface ModelToolCall {
  readonly name: string;
  readonly input: string;
  readonly output: string;
  readonly failed: boolean;
}

export interface ModelStep {
  readonly usage: Usage;
  readonly toolCalls: readonly ModelToolCall[];
}
