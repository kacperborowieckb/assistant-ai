import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { loadEvalCases } from "./eval-cases.ts";

const casesDirectoryWith = (files: Record<string, string>) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "agent-eval-cases-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(nodePath.join(directory, name), content);
  }
  return directory;
};

const validCase = `export default {
  description: "A valid case",
  events: [{ text: "keep: buy milk" }],
  checks: [{ check: "note_count", equals: 1 }],
};
`;

const failureMessage = <Value, Failure extends Error>(
  exit: Exit.Exit<Value, Failure>
) =>
  Exit.match(exit, {
    onSuccess: () => "",
    onFailure: String,
  });

describe("Eval Case files", () => {
  it("loads every case in the repository, named after its file", async () => {
    const cases = await Effect.runPromise(loadEvalCases());

    expect(cases.map((evalCase) => evalCase.name)).toContain(
      "capture-task-with-date"
    );
  });

  it("fails with a schema error that names the file and the field", async () => {
    const directory = casesDirectoryWith({
      "valid.ts": validCase,
      "broken.ts": `export default {
  description: "A case with a check that does not exist",
  events: [{ text: "hello" }],
  checks: [{ check: "note_count", equals: -1 }],
};
`,
    });

    const exit = await Effect.runPromiseExit(loadEvalCases({ directory }));

    expect(Exit.isFailure(exit)).toBe(true);
    const message = failureMessage(exit);
    expect(message).toContain("The Eval Case file broken.ts is invalid");
    expect(message).toContain('["checks"][0]');
  });

  it("fails when a case has no Owner Events", async () => {
    const directory = casesDirectoryWith({
      "empty.ts": `export default {
  description: "No events",
  events: [],
  checks: [{ check: "note_count", equals: 0 }],
};
`,
    });

    const message = failureMessage(
      await Effect.runPromiseExit(loadEvalCases({ directory }))
    );

    expect(message).toContain("The Eval Case file empty.ts is invalid");
    expect(message).toContain('["events"]');
  });

  it("selects cases by name and refuses an unknown name", async () => {
    const directory = casesDirectoryWith({
      "first.ts": validCase,
      "second.ts": validCase,
    });

    const selected = await Effect.runPromise(
      loadEvalCases({ directory, names: ["second"] })
    );
    const unknown = failureMessage(
      await Effect.runPromiseExit(
        loadEvalCases({ directory, names: ["third"] })
      )
    );

    expect(selected.map((evalCase) => evalCase.name)).toStrictEqual(["second"]);
    expect(unknown).toContain(
      "No Eval Case is named third. Known cases: first, second."
    );
  });
});
