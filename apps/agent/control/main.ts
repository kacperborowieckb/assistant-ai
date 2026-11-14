import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import {
  bundleTargets,
  measureBundle,
  renderMeasurement,
  withinSizeLimit,
} from "./bundle.ts";
import { runLocalWorker } from "./dev.ts";
import { diagnose, isHealthy, renderDiagnosis } from "./doctor.ts";
import {
  featureMapIsCurrent,
  featureMapPath,
  writeFeatureMap,
} from "./feature-map.ts";
import {
  addOwner,
  localWorkerUrl,
  operatorToken,
  renderAddedOwner,
} from "./operator.ts";
import { requestReply } from "./request.ts";
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
    "Apply the Directory migrations to local D1, then run the Worker locally with local Durable Objects, a fake Telegram API, and a fake model. No remote resources."
  )
);

const ownerAdd = Command.make(
  "add",
  {
    telegramUser: Flag.Int("telegram-user").pipe(
      Flag.withDescription("The Owner's Telegram user id")
    ),
    url: Flag.String("url").pipe(
      Flag.withDescription("The Worker URL"),
      Flag.withDefault(localWorkerUrl)
    ),
  },
  ({ telegramUser, url }) =>
    Effect.gen(function* ownerAddCommand() {
      const token = yield* operatorToken;
      const owner = yield* addOwner({
        workerUrl: url,
        token,
        telegramUserId: telegramUser,
      });
      yield* Console.log(renderAddedOwner(owner));
    })
).pipe(
  Command.withDescription(
    "Add the Owner and their Telegram identity through the Worker's Operator route, which writes through the Directory. Reads OPERATOR_TOKEN from the environment or .dev.vars."
  )
);

const owner = Command.make("owner").pipe(
  Command.withDescription("Manage the Owners of an Instance"),
  Command.withSubcommands([ownerAdd])
);

const request = Command.make(
  "request",
  {
    contains: Flag.String("contains").pipe(
      Flag.withDescription("Text that the reply must contain")
    ),
    message: Flag.String("message").pipe(
      Flag.withDescription("The Owner's text message"),
      Flag.withDefault("Hello agent")
    ),
  },
  ({ contains, message }) =>
    requestReply({ contains, message }).pipe(Effect.flatMap(Console.log))
).pipe(
  Command.withDescription(
    "Start the Worker locally with temporary storage, a fake Telegram API, and a fake model. Add an Owner, send a sample Telegram text message, and check that the reply contains the text. No network."
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
    "Build the Worker with a dry run. Fail when the bundle is over the Workers size limit, and show the local startup CPU."
  )
);

const map = Command.make(
  "map",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Fail when the Feature Map is out of date"),
      Flag.withDefault(false)
    ),
  },
  ({ check }) =>
    Effect.gen(function* mapCommand() {
      if (!check) {
        yield* Effect.sync(writeFeatureMap);
        yield* Console.log(`Wrote ${featureMapPath}`);
        return;
      }
      const current = yield* Effect.sync(featureMapIsCurrent);
      yield* Console.log(
        current
          ? "The Feature Map is current."
          : "The Feature Map is out of date. Run pnpm control map."
      );
      yield* exitWithFailureWhen(!current);
    })
).pipe(
  Command.withDescription(
    "Generate the Feature Map of the Edge routes in docs/verification/agent-feature-map.md, or check it with --check."
  )
);

const control = Command.make("control").pipe(
  Command.withDescription("Control CLI for apps/agent"),
  Command.withSubcommands([doctor, dev, owner, request, map, bundle])
);

Command.run(control, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
