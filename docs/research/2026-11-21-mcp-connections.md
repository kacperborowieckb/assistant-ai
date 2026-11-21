# MCP Connections on Cloudflare: research for the spec

Date: 2026-11-21

Status: research source for the MCP Connection spec. It builds on spec 1, [Actions and Approval (#139)](https://github.com/kacperborowieckb/billy/issues/139). Use it as the input for a grilling session or for `to-spec`. Where a later decision differs from this research, the decision is correct.

## Goal

One generic way to connect any supported remote MCP server (for example Notion or Google) from the chat. No integration code for one service.

## Short answer

An MCP Connection does not keep the Personal Agent awake. The real costs are:

1. Work on every wake, when the default Agents SDK restore reconnects every stored server.
2. Model context, when every MCP tool goes into every Turn.
3. OAuth, which is most of the code in every project that we studied.

The recommended shape: a separate MCP hub Durable Object for each Owner, a lazy connection on the first call, a tool search step in place of the full tool list, and Approval for every MCP call by default.

## Core findings

### F1. An MCP Connection is a stored record, not a live link

A remote MCP server uses Streamable HTTP. Each MCP request (`initialize`, `tools/list`, `tools/call`) is one outbound HTTP request. No socket must stay open between Turns.

The Agents SDK `MCPClientManager` stores each server in the SQLite of its Durable Object: the URL, the transport options, the OAuth client and tokens, and a cached tool list (`discoverResult`). The object sleeps as usual. When it wakes, it reads the record and connects again.

### F2. The SDK default reconnects every server on every wake

Checked in `agents@0.33.0`, the pinned version. `Agent.onStart()` calls `restoreConnectionsFromStorage()`. For each stored server, that starts a background connect and tool discovery. `waitForConnections()` waits until they settle.

Effect on this project: every Telegram message, Schedule alarm, and Approval button press makes one handshake for each connected server. This happens also when the Turn needs no MCP tool, or when no model runs at all. A slow server delays the Turn up to the wait timeout. If the agent does not wait, the tools are missing from the first Turn after a wake ([cloudflare/agents#928](https://github.com/cloudflare/agents/issues/928)).

`PersonalAgent` extends `Agent`, so this restore runs in the Personal Agent if we call `this.addMcpServer()` there (decision 0009).

### F3. Limits that matter

| Limit | Why it matters |
| --- | --- |
| Model context and tool choice | Notion and Google servers each have tens of tools. All of them in every Turn make the prompt large and the tool choice worse. This is the largest limit. |
| Work on each wake | See F2. Outbound requests and latency on wakes that do not need MCP. |
| CPU at Worker start | Importing `agents` loads the MCP SDK at start, about 70 ms of CPU, also with no MCP server ([cloudflare/agents#2418](https://github.com/cloudflare/agents/issues/2418), open). |
| OAuth token life | Tokens expire. Refresh tokens rotate. A server can drop its session. A connection can park in `authenticating` or `failed`, and the Owner must know. |
| OAuth scope step-up | A server can ask for more scopes in the middle of a session. The SDK did not show this ([cloudflare/agents#2658](https://github.com/cloudflare/agents/issues/2658)). |
| Secrets at rest | The SDK stores `requestInit.headers` (bearer tokens) in plain text in `cf_agents_mcp_servers` ([cloudflare/agents#2823](https://github.com/cloudflare/agents/issues/2823), closed as not planned). |
| Durability of a call | A call in progress is lost when the object restarts. MCP calls are not idempotent by default, so a result can be `unconfirmed` (spec 1 lifecycle). |

### F4. Prior art on Cloudflare

| Project | Where connections live | When it connects | How the model sees tools | Safety |
| --- | --- | --- | --- | --- |
| [kody-hq/kody](https://github.com/kody-hq/kody) (Kent C. Dodds, about 1k stars) | A separate `McpClientHub` Durable Object for each user. A D1 table tells which servers are on, without a wake of the hub. | Lazy: `ensureRestored()` on the first RPC to the hub, then `waitForConnections` with a timeout. | No full list. `search` finds a server, then code calls `kody.mcp["name"].tool()` (codemode). | Package locks. One audit row for each call, without arguments or results. Sealed secrets. |
| [deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv) (personal assistant, 135 stars) | The main Kernel Durable Object. It replaced the SDK manager with its own client and kept the SDK table. | Eager: detached restore on every wake. | `mcp list`, `mcp search`, `mcp describe`, `mcp call`. | Every MCP call asks for Approval by default. Durable pause. Approvals expire. Blocks private and internal URLs. |
| [bensenescu/downy](https://github.com/bensenescu/downy) (200 stars) | The agent Durable Object (Think). Keeps its own copy of each server config. | Eager on wake. | All tools with `getAITools()`. | Bearer tokens in plain SQLite, noted in a code comment. |
| [jonnyparris/dodo](https://github.com/jonnyparris/dodo) (coding agent) | A hub Durable Object. |  |  | Own handling of OAuth step-up in the middle of a session. |

Other evidence:

- [cloudflare/agents#2823](https://github.com/cloudflare/agents/issues/2823): one host ("managed-agents") makes `restoreConnectionsFromStorage()` a no-op and registers each server again on demand.
- [cloudflare/agents#1545](https://github.com/cloudflare/agents/issues/1545) (open): a proposal that one parent agent owns the MCP connections and other agents call tools through it. This is the hub shape.

### F5. What Kody teaches about OAuth

Kody has more than 50 files in `packages/worker/src/mcp-client/`. Almost all of them are OAuth. Lessons to keep:

- Client identity in this order: Client ID Metadata Document (CIMD), then Dynamic Client Registration (DCR), then a pre-registered OAuth client that the Operator enters. GitHub's MCP server supports neither CIMD nor DCR.
- A consent page before the redirect to the provider. It shows the server, the authorization server, and the client mode.
- The callback finds the right hub from the `state` value and checks the RFC 9207 `iss`.
- Keep the old refresh token when the token response has no new one. Let only one refresh run at a time for one rotating refresh token.
- A callback replay settles with the tokens from the first exchange.
- A durable, sanitized `last_error` for each server, so the status never stays silent.
- A disconnect event when a ready server needs sign-in again, so the user gets a notice.
- Seal tokens and client secrets at rest. No API returns them.

### F6. Which project is closest

- For the connection layer, Kody is closest: hub Durable Object, lazy restore, OAuth.
- For the product, gsv is closest: a personal assistant with its own agent loop and Approval for MCP calls.
- Kody is a cloud for other agents (an MCP server that runs their code). It has no chat loop, model, or Channel of its own. It is built for many users and orgs (D1, package locks). Do not copy those parts.

Target: Kody's connection layer with gsv's Approval rule, on our own Turn, Approval gate, and Telegram Channel.

## Recommended approaches

### A1. A separate MCP hub Durable Object for each Owner

- The hub owns `MCPClientManager`, the server records, and the sealed tokens. The Personal Agent calls it through RPC.
- The Personal Agent keeps a cached tool catalog for each MCP Connection. A Turn reads the catalog with no call to the hub.
- Telegram messages, alarms, and Approval presses never wake the hub. Only an MCP call or a connection change wakes it.
- Keep the SDK behind our own interface (decision 0003).
- This changes decision 0009, which says to use `this.addMcpServer()` in the Personal Agent. Record the change in the new decision.

### A2. Connect on the first call

- The hub restores a server only on the first call for it (Kody `ensureRestored()` pattern), then waits with a timeout from the Behavior Config.
- A server that is not `ready` gives the model a clear failure with what to do next. It does not wait without limit.
- Refresh the tool catalog on connect, on an explicit refresh, and when the server sends `tools/list_changed`.

### A3. Search for tools, do not list them all

- The model gets a small, fixed set of generic tools, for example: find a Connection tool (by name and description), describe a tool (input schema), and call a tool.
- The tool set does not change during a Turn, which keeps the prompt cache warm (feasibility research: no tool changes during a Turn).
- Open option: each MCP Connection has a set of enabled tools, with a default from the catalog.

### A4. Approval for every MCP call (spec 1)

- An MCP call has Risk Class `approve` by default. Server annotations (`readOnlyHint`, `destructiveHint`) are Untrusted Content and cannot lower the class.
- Open option: the Owner marks one tool as `read` or `change`, stored for each MCP Connection. Code, not the model, stores it.
- Code writes the summary: Connection name, tool name, and the arguments as plain text. The model's text is never the summary.
- Every MCP result is Untrusted Content. After it, the Turn is `untrusted` for the rest of the Turn.
- Spec 1 runs an approved call exactly once through the recorded tool call. A lost result becomes `unconfirmed`.

### A5. Connect from the chat

- The Owner asks in chat. The agent replies with a link to a consent page on the Edge. The page leads to the provider.
- The OAuth callback reaches the Edge. The Edge finds the Owner's hub from `state`. The hub exchanges the code.
- Client identity: CIMD, then DCR, then a pre-registered client from the Operator.
- Block URLs to private and internal addresses.
- Adding or removing an MCP Connection is a Journal Entry. Each MCP call is a Journal Entry without secret values.

### A6. Connection health in the chat

- Each MCP Connection has a state: `authenticating`, `ready`, `failed`, `needs sign-in`.
- When a ready MCP Connection needs sign-in again, the Owner gets one message with the reconnect link.
- A scope step-up in the middle of a call becomes the same message, and the call fails with a clear result.

### A7. Out of scope for the first spec

- Codemode (MCP calls through generated code). It is a separate decision.
- MCP tools in Proactive Turns and Scheduled Task Turns. Spec 1 allows Pending Approvals only in Owner message Turns.
- MCP servers that dial in to the agent, and local (stdio) servers.
- Copies of external data. Use pointer Notes (vision: "pointer Notes and no copies").

## Conflicts with current decisions

| Decision | Conflict | Proposal |
| --- | --- | --- |
| 0009 | MCP tools come from `this.addMcpServer()` in the Personal Agent. | A hub Durable Object owns the connections. The Personal Agent gets MCP tools through our interface. |
| Spec 1 (0026) | "Revisit if: a result needs a model summary (for example MCP output)." | Keep code-written summaries of the call. The result status line stays code-written. Decide whether the Owner sees any MCP output in the Approval message. |
| Spec 1 (0026) | Only Owner message Turns can create Pending Approvals. | MCP tools exist only in Owner message Turns in the first version. |
| Feasibility research | "Agents SDK MCP client to remote MCP servers; OAuth tokens in DO storage." | Same, but in the hub, with sealed tokens. |

## Questions for the grilling session

1. Hub Durable Object or MCP in the Personal Agent with the SDK restore turned off?
2. Which servers can an Owner connect: a curated catalog from the Operator, any URL, or a catalog plus custom URLs?
3. Which tools does the model see: a search step only, a set of enabled tools for each MCP Connection, or both?
4. Default Risk Class of an MCP call: always `approve`, or `approve` with an Owner override to `read`?
5. What does the Approval summary show for MCP arguments that are large or nested?
6. Does the Owner see MCP output in chat, or does the agent always answer in its own words?
7. Where does the consent page live, and how does it prove that the Owner is the one who opens it (Telegram has no browser session)?
8. Bearer-token servers: allowed in the first version or not?
9. How large can an MCP result be before code cuts it, and is the full result stored?
10. Do Proactive Turns or Scheduled Task Turns get read-only MCP tools later?
11. What is the new name in `CONTEXT.md`: "MCP Connection" and a name for the hub?
12. Which Eval Cases prove it, and when (decision 0019 keeps Eval Cases for later)?

## Not checked

- If Google's remote MCP servers support CIMD or DCR, or need a pre-registered client.
- The cost of the hub Durable Object compared with one object for each Owner.
- If a Streamable HTTP server can keep a GET stream open that holds the object in memory.

## Sources

Read on 2026-11-21.

- [Spec 1: Actions and Approval (#139)](https://github.com/kacperborowieckb/billy/issues/139)
- Decisions [0003](../decisions/0003-runtime-and-model-stack.md) and [0009](../decisions/0009-agent-loop-and-client-boundaries.md)
- Agents SDK 0.33.0: `docs/mcp-client.md`, `docs/lifecycle.md`, and `restoreConnectionsFromStorage()` in `dist/client-*.js`
- Kody: `docs/use/mcp-client-servers.md`, `docs/contributing/architecture/mcp-client-servers.md`, `packages/worker/src/mcp-client/hub.ts`
- gsv: `workers/gateway/src/kernel/mcp-client.ts`, `workers/gateway/src/kernel/do.ts`, `docs/how-to/integrations.md`, `docs/architecture/security-model.md`
- downy: `src/worker/agent/DownyAgent.ts`
- dodo: `src/mcp-step-up.ts`
- Agents SDK issues [#928](https://github.com/cloudflare/agents/issues/928), [#1545](https://github.com/cloudflare/agents/issues/1545), [#2418](https://github.com/cloudflare/agents/issues/2418), [#2658](https://github.com/cloudflare/agents/issues/2658), [#2823](https://github.com/cloudflare/agents/issues/2823)
