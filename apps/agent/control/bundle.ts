import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { gzipSync } from "node:zlib";

import { Effect, Schema } from "effect";

import { runWranglerQuietly } from "./wrangler.ts";

export interface BundleTarget {
  readonly name: string;
  readonly entry: string;
}

export interface BundleMeasurement {
  readonly target: BundleTarget;
  readonly sizeBytes: number;
  readonly gzipBytes: number;
  readonly startupMs: number;
}

export const bundleTargets: readonly BundleTarget[] = [
  { name: "Worker", entry: "src/index.ts" },
];

export const workerSizeLimitBytes = 64 * 1024 * 1024;
export const startupLimitMs = 1000;

const CpuProfile = Schema.fromJsonString(
  Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        callFrame: Schema.Struct({ functionName: Schema.String }),
      })
    ),
    samples: Schema.Array(Schema.Number),
    timeDeltas: Schema.Array(Schema.Number),
  })
);

const readUploadedModules = async (bundlePath: string) => {
  const bytes = readFileSync(bundlePath);
  const boundary = bytes.subarray(2, bytes.indexOf(10)).toString().trim();
  const form = await new Response(bytes, {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  return [...form.values()].filter(
    (part): part is File =>
      part instanceof Blob && part.type !== "application/source-map"
  );
};

const measureSize = async (bundlePath: string) => {
  const modules = new Blob(await readUploadedModules(bundlePath));
  return {
    sizeBytes: modules.size,
    gzipBytes: gzipSync(await modules.arrayBuffer()).byteLength,
  };
};

const activeStartupMs = (profilePath: string) => {
  const profile = Schema.decodeUnknownSync(CpuProfile)(
    readFileSync(profilePath, "utf-8")
  );
  const idleNodes = new Set(
    profile.nodes
      .filter((node) => node.callFrame.functionName === "(idle)")
      .map((node) => node.id)
  );
  let activeMicroseconds = 0;
  for (const [index, delta] of profile.timeDeltas.entries()) {
    if (!idleNodes.has(profile.samples[index] ?? -1)) {
      activeMicroseconds += delta;
    }
  }
  return activeMicroseconds / 1000;
};

export const measureBundle = Effect.fnUntraced(function* measureBundle(
  target: BundleTarget
) {
  const workDirectory = mkdtempSync(nodePath.join(tmpdir(), "agent-bundle-"));
  const bundlePath = nodePath.join(workDirectory, "worker.bundle");
  const profilePath = nodePath.join(workDirectory, "startup.cpuprofile");

  yield* runWranglerQuietly([
    "deploy",
    target.entry,
    "--dry-run",
    "--outfile",
    bundlePath,
  ]);
  yield* runWranglerQuietly([
    "check",
    "startup",
    "--worker",
    bundlePath,
    "--outfile",
    profilePath,
  ]);
  const size = yield* Effect.promise(() => measureSize(bundlePath));

  return {
    target,
    ...size,
    startupMs: activeStartupMs(profilePath),
  } satisfies BundleMeasurement;
});

export const withinSizeLimit = (measurement: BundleMeasurement) =>
  measurement.sizeBytes <= workerSizeLimitBytes;

const kibibytes = (bytes: number) => `${(bytes / 1024).toFixed(2)} KiB`;

export const renderMeasurement = (measurement: BundleMeasurement) =>
  [
    `${measurement.target.name} (${measurement.target.entry}): ${withinSizeLimit(measurement) ? "within the size limit" : "OVER THE SIZE LIMIT"}`,
    `  Size: ${kibibytes(measurement.sizeBytes)} of ${kibibytes(workerSizeLimitBytes)} (gzip ${kibibytes(measurement.gzipBytes)}, not limited)`,
    `  Local startup CPU: ${measurement.startupMs.toFixed(1)} ms; the limit on Cloudflare is ${startupLimitMs} ms. Local CPU differs, so this is an estimate and is not enforced.`,
  ].join("\n");
