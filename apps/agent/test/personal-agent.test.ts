import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { OwnerIdSchema } from "../src/owner-id.ts";
import { AgentStorage } from "../src/personal-agent/agent-storage.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";

const ownerA = OwnerIdSchema.make("owner-a");
const ownerB = OwnerIdSchema.make("owner-b");

const sampleTable = Effect.gen(function* sampleTableEffect() {
  const { database } = yield* AgentStorage;
  database.run(sql`CREATE TABLE IF NOT EXISTS sample (text TEXT NOT NULL)`);
  return database;
});

const storeNote = (text: string) =>
  Effect.gen(function* storeNoteEffect() {
    const database = yield* sampleTable;
    database.run(sql`INSERT INTO sample (text) VALUES (${text})`);
  });

const readNotes = Effect.gen(function* readNotesEffect() {
  const database = yield* sampleTable;
  return database
    .all<{ text: string }>(sql`SELECT text FROM sample`)
    .map((row) => row.text);
});

describe("Personal Agent", () => {
  it("keeps one Effect runtime across requests", async () => {
    const agent = await personalAgentFor(env.PERSONAL_AGENT, ownerA);

    const first = await runInDurableObject(
      agent,
      (instance) => instance.runtime
    );
    const second = await runInDurableObject(
      agent,
      (instance) => instance.runtime
    );

    expect(second).toBe(first);
  });

  it("runs Effects against the SQLite storage of its own Owner only", async () => {
    const agentA = await personalAgentFor(env.PERSONAL_AGENT, ownerA);
    const agentB = await personalAgentFor(env.PERSONAL_AGENT, ownerB);

    await runInDurableObject(agentA, (instance) =>
      instance.runtime.runPromise(storeNote("for owner a"))
    );

    expect(
      await runInDurableObject(agentA, (instance) =>
        instance.runtime.runPromise(readNotes)
      )
    ).toEqual(["for owner a"]);
    expect(
      await runInDurableObject(agentB, (instance) =>
        instance.runtime.runPromise(readNotes)
      )
    ).toEqual([]);
  });
});
