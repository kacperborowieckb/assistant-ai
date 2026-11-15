import { readdirSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Effect, Schema } from "effect";

import { EvalCaseInvalid } from "./eval-case-invalid.ts";
import { EvalCaseUnknown } from "./eval-case-unknown.ts";
import { EvalCaseSchema } from "./eval-case.ts";
import type { EvalCase } from "./eval-case.ts";

export const evalCasesDirectory = fileURLToPath(
  new URL("cases", import.meta.url)
);

const caseFileExtension = ".ts";

const ModuleSchema = Schema.Struct({ default: EvalCaseSchema });

const loadCaseFile = (directory: string, fileName: string) =>
  Effect.tryPromise({
    try: (): Promise<unknown> =>
      import(pathToFileURL(nodePath.join(directory, fileName)).href),
    catch: (cause) =>
      new EvalCaseInvalid({ file: fileName, issue: String(cause) }),
  }).pipe(
    Effect.flatMap((module) =>
      Schema.decodeUnknownEffect(ModuleSchema)(module).pipe(
        Effect.mapError(
          ({ message }) =>
            new EvalCaseInvalid({ file: fileName, issue: message })
        )
      )
    ),
    Effect.map((module): EvalCase => ({
      name: nodePath.basename(fileName, caseFileExtension),
      ...module.default,
    }))
  );

const selected = (cases: readonly EvalCase[], names: readonly string[]) => {
  if (names.length === 0) {
    return Effect.succeed(cases);
  }
  const known = cases.map((evalCase) => evalCase.name);
  const unknown = names.filter((name) => !known.includes(name));
  return unknown.length > 0
    ? Effect.fail(new EvalCaseUnknown({ names: unknown, known }))
    : Effect.succeed(cases.filter((evalCase) => names.includes(evalCase.name)));
};

export const loadEvalCases = ({
  directory = evalCasesDirectory,
  names = [],
}: {
  readonly directory?: string;
  readonly names?: readonly string[];
} = {}) =>
  Effect.all(
    readdirSync(directory)
      .filter((fileName) => fileName.endsWith(caseFileExtension))
      .toSorted()
      .map((fileName) => loadCaseFile(directory, fileName))
  ).pipe(Effect.flatMap((cases) => selected(cases, names)));
