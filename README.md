# Personal agent foundation

Working name: assistant-ai. A self-hosted personal agent that you text like a colleague: it remembers what you tell it and starts the conversation when it can help. `apps/agent` holds the agent Worker. Its verification guide is [docs/verification/agent.md](docs/verification/agent.md).

Use the Node.js and pnpm versions specified in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

- [Vision](docs/product/vision.md), [MVP](docs/product/mvp.md), and [architecture](docs/product/architecture.md)
- [Ubiquitous language](CONTEXT.md)
- [Contributing and issue priorities](CONTRIBUTING.md)
- [Repository foundation](docs/decisions/0001-repository-foundation.md)
- [Agent authority](docs/decisions/0002-agent-authority.md)
- [Primitives catalog](docs/primitives/README.md)
- [Self-verification and current Actions limit](docs/verification/README.md)
