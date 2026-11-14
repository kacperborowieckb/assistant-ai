import nodePath from "node:path";

import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { agentRoot } from "./workspace.ts";

const wranglerBin = nodePath.join(
  agentRoot,
  "node_modules",
  ".bin",
  "wrangler"
);

const wranglerCommand = (args: readonly string[], output: "inherit" | "pipe") =>
  ChildProcess.make(wranglerBin, args, {
    cwd: agentRoot,
    env: { WRANGLER_SEND_METRICS: "false" },
    extendEnv: true,
    stdin: output === "inherit" ? "inherit" : "ignore",
    stdout: output,
    stderr: output,
  });

export class WranglerFailed extends Data.TaggedError("WranglerFailed")<{
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly output: string;
}> {
  override get message() {
    return `wrangler ${this.args.join(" ")} exited with ${this.exitCode}\n${this.output}`;
  }
}

export const runWranglerAttached = Effect.fnUntraced(
  function* runWranglerAttached(args: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(wranglerCommand(args, "inherit"));
    if (exitCode !== 0) {
      return yield* new WranglerFailed({ args, exitCode, output: "" });
    }
  }
);

export const runWranglerQuietly = Effect.fnUntraced(
  function* runWranglerQuietly(args: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(wranglerCommand(args, "pipe"));
    const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString);
    const exitCode = yield* handle.exitCode;
    if (exitCode !== 0) {
      return yield* new WranglerFailed({ args, exitCode, output });
    }
  },
  Effect.scoped
);
