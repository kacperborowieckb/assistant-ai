# 0009: Agent loop and client boundaries

Status: accepted

Date: 2026-11-15

Extends [0003](0003-runtime-and-model-stack.md). It records how we use the Agents SDK and the AI SDK when tools, MCP, and the mobile app arrive.

## Decision

### Personal Agent base class

`PersonalAgent` extends the base `Agent` class. Do not use `AIChatAgent` from `@cloudflare/ai-chat` or `@cloudflare/think`. `Conversation` owns the message history.

### Tool loop

The tool loop runs inside the Model Gateway with the AI SDK loop: `ToolLoopAgent`, or `generateText` with `tools` and `stopWhen`. Each Turn has an explicit step limit. Each tool `execute` runs through the shared Effect runtime of the Personal Agent, as 0003 says.

Approval uses the AI SDK `toolApproval` option. Do not use `needsApproval` on `tool()`. The AI SDK marks it as deprecated, but some Cloudflare examples still use it.

MCP tools come from the Agents SDK MCP client (`this.addMcpServer()`), because it keeps each server connection in the SQLite storage of the Personal Agent. The Model Gateway gets them as AI SDK tools.

### Message storage

When the first tool arrives, `Conversation` stores AI SDK `ModelMessage` values, checked by a schema, in place of `{ role, text }`. A versioned migration converts the existing rows. Tool calls and tool results then replay in the next Turn.

### Work that must finish

Tool work that must finish after a deploy or a crash runs as a Schedule or a Helper (a Workflow). A Turn does not keep long work in memory.

### Mobile client

The mobile app talks to the Personal Agent through our own Mobile Channel protocol over a WebSocket. Its schemas live in `packages/contracts`. The app does not use the Agents SDK client packages (`agents/client`, `agents/react`, `useAgentChat`) or the AI SDK UI hooks. All model work stays in the Personal Agent.

## Why

The AI SDK is the model layer of the Agents SDK. The Agents SDK gives the runtime: state, Schedules, and MCP connections. Each SDK does the job that it does best, and the chat model stays in one place.

`AIChatAgent` is made for browser chat through `useAgentChat`. Our Channels are Telegram and, later, a native app, and every Channel must use one history and one send action (decision 0004). The Cloudflare Agents README now sends new chat projects to `@cloudflare/think`, so the chat API still changes. Our own `Conversation` keeps the history independent of that API.

A `{ role, text }` row cannot hold tool calls or tool results. Without them, the model forgets in the next Turn what its tools did.

The Cloudflare docs say that an agent alone is not durable through a deploy or a crash, and recommend a Schedule or a Workflow for work that must finish.

The Cloudflare client SDK docs list browsers, Node.js, Deno, Bun, and edge functions, and do not mention React Native or Expo. The AI SDK Expo quickstart needs `expo/fetch`, polyfills, and an HTTP chat route. Our own protocol keeps the app free of both, and makes the mobile app one more Channel adapter.

Sources, read on 2026-11-15: [AI SDK agents](https://ai-sdk.dev/docs/agents/building-agents), [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [AI SDK Expo](https://ai-sdk.dev/docs/getting-started/expo), [Agents SDK](https://developers.cloudflare.com/agents/), [chat agents](https://developers.cloudflare.com/agents/api-reference/chat-agents/), [client SDK](https://developers.cloudflare.com/agents/api-reference/client-sdk/), [MCP client](https://developers.cloudflare.com/agents/model-context-protocol/), [Workflows](https://developers.cloudflare.com/agents/agent-class/run-workflows/).

## Revisit if

- The Agents SDK client packages support React Native, and they would remove more code than our own protocol.
- `@cloudflare/think` or `AIChatAgent` supports more than one Channel and a history that is not tied to the browser.
- The AI SDK removes `toolApproval` or changes its tool loop API.
