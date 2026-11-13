import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index.ts";

describe("Edge", () => {
  it("answers 404 for a route that does not exist", async () => {
    const response = await worker.fetch(
      new Request("https://agent.test/unknown"),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(404);
  });
});

describe("Test runtime", () => {
  it("refuses outbound network requests", async () => {
    const response = await fetch("https://example.com/");

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      "Network is off in tests: https://example.com/"
    );
  });
});
