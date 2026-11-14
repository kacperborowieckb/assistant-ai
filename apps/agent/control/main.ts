import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import {
  bundleTargets,
  measureBundle,
  renderMeasurement,
  withinSizeLimit,
} from "./bundle.ts";
import { runLocalWorker } from "./dev.ts";
import { diagnose, isHealthy, renderDiagnosis } from "./doctor.ts";
import { wranglerConfigPath } from "./workspace.ts";

const exitWithFailureWhen = (failed: boolean) =>
  Effect.sync(() => {
    if (failed) {
      process.exitCode = 1;
    }
  });

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* doctorCommand() {
    const diagnosis = yield* Effect.sync(() => diagnose(wranglerConfigPath));
    yield* Console.log(renderDiagnosis(diagnosis));
    yield* exitWithFailureWhen(!isHealthy(diagnosis));
  })
).pipe(
  Command.withDescription(
    "Check the Worker configuration and name the required secrets that are missing for local dev. Never prints secret values."
  )
);

const dev = Command.make("dev", {}, () => runLocalWorker).pipe(
  Command.withDescription(
    "Run the Worker locally with local D1 and Durable Objects. No remote resources."
  )
);

const bundle = Command.make("bundle", {}, () =>
  Effect.gen(function* bundleCommand() {
    const measurements = yield* Effect.all(
      bundleTargets.map((target) => measureBundle(target))
    );
    for (const measurement of measurements) {
      yield* Console.log(renderMeasurement(measurement));
    }
    yield* exitWithFailureWhen(!measurements.every(withinSizeLimit));
  })
).pipe(
  Command.withDescription(
    "Build the Worker and the full stack probe with a dry run. Fail when a bundle is over the Workers size limit, and show the local startup CPU."
  )
);

const control = Command.make("control").pipe(
  Command.withDescription("Control CLI for apps/agent"),
  Command.withSubcommands([doctor, dev, bundle])
);

Command.run(control, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
