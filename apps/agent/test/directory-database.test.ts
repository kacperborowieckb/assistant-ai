import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Directory database", () => {
  it("reads its own writes through a D1 session", async () => {
    await env.DIRECTORY.exec(
      "CREATE TABLE sample (id TEXT PRIMARY KEY NOT NULL)"
    );
    const session = env.DIRECTORY.withSession("first-primary");

    await session.prepare("INSERT INTO sample (id) VALUES (?)").bind("a").run();
    const rows = await session.prepare("SELECT id FROM sample").all();

    expect(rows.results).toEqual([{ id: "a" }]);
  });
});
