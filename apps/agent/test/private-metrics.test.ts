import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMetrics, failModel, fakeTelegram, resetFakes } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const waitForDataPoints = (count: number) =>
  vi.waitFor(() => expect(fakeMetrics.dataPoints).toHaveLength(count), {
    timeout: 10_000,
  });

beforeEach(() => {
  resetFakes();
});

describe("Private metrics", () => {
  it("records latency, tokens, cache hits, and the result of a Turn, with no content", async () => {
    const ownerId = await addOwner(9001);

    await telegramWebhook(
      textUpdate({ fromUserId: 9001, text: "My private secret plan" })
    );
    await waitForDataPoints(1);

    const [point] = fakeMetrics.dataPoints;
    expect(point?.indexes).toEqual([ownerId]);
    expect(point?.blobs).toEqual([
      "turn",
      "replied",
      "fake-reply-model",
      "cost_unknown",
    ]);
    expect(point?.doubles?.slice(1)).toEqual([42, 7, 0, 12]);
    expect(point?.doubles?.[0]).toBeGreaterThanOrEqual(0);
    const everything = JSON.stringify(fakeMetrics.dataPoints);
    expect(everything).not.toContain("private secret plan");
    expect(everything).not.toContain("You said");
  });

  it("records a Turn whose model failed with its result and no tokens", async () => {
    const ownerId = await addOwner(9002);
    failModel(3);

    await telegramWebhook(textUpdate({ fromUserId: 9002, text: "Hello" }));
    await waitForDataPoints(1);

    const [point] = fakeMetrics.dataPoints;
    expect(point?.indexes).toEqual([ownerId]);
    expect(point?.blobs?.slice(0, 2)).toEqual(["turn", "model_failed"]);
    expect(point?.doubles?.slice(1)).toEqual([0, 0, 0, 0]);
  });

  it("records a Turn whose send Telegram refused as send_failed", async () => {
    await addOwner(9003);
    fakeTelegram.answerWith("refuse");

    await telegramWebhook(textUpdate({ fromUserId: 9003, text: "Hello" }));
    await waitForDataPoints(1);

    expect(fakeMetrics.dataPoints[0]?.blobs?.slice(0, 2)).toEqual([
      "turn",
      "send_failed",
    ]);
  });

  it.each([
    ["a missing secret token", null],
    ["a wrong secret token", "wrong-token"],
  ])("records a refused request for %s with no Owner", async (_, secret) => {
    await telegramWebhook(
      textUpdate({ fromUserId: 9004, text: "Hello" }),
      secret
    );

    expect(fakeMetrics.dataPoints).toHaveLength(1);
    const [point] = fakeMetrics.dataPoints;
    expect(point?.indexes).toEqual(["none"]);
    expect(point?.blobs?.slice(0, 2)).toEqual(["refused", "bad_secret_token"]);
  });

  it("records a refused request from an unknown sender with no content", async () => {
    await telegramWebhook(
      textUpdate({ fromUserId: 9005, text: "Who is this stranger" })
    );

    expect(fakeMetrics.dataPoints).toHaveLength(1);
    expect(fakeMetrics.dataPoints[0]?.blobs?.slice(0, 2)).toEqual([
      "refused",
      "unknown_sender",
    ]);
    expect(JSON.stringify(fakeMetrics.dataPoints)).not.toContain("stranger");
  });

  it("records a refused request from an Owner who is not active under that Owner", async () => {
    const ownerId = await addOwner(9006);
    await env.DIRECTORY.prepare(
      "UPDATE owners SET status = 'suspended' WHERE owner_id = ?"
    )
      .bind(ownerId)
      .run();

    await telegramWebhook(textUpdate({ fromUserId: 9006, text: "Hello" }));

    expect(fakeMetrics.dataPoints).toHaveLength(1);
    expect(fakeMetrics.dataPoints[0]?.indexes).toEqual([ownerId]);
    expect(fakeMetrics.dataPoints[0]?.blobs?.slice(0, 2)).toEqual([
      "refused",
      "owner_not_active",
    ]);
  });

  it("still answers 401 and 200 at the Edge when the metric cannot be written", async () => {
    fakeMetrics.failWrites();
    await addOwner(9007);

    const refused = await telegramWebhook(
      textUpdate({ fromUserId: 9007, text: "Hello" }),
      "wrong-token"
    );
    const unknown = await telegramWebhook(
      textUpdate({ fromUserId: 9008, text: "Hello" })
    );

    expect(refused.status).toBe(401);
    expect(unknown.status).toBe(200);
  });

  it("still answers every pending Event when the metric cannot be written", async () => {
    fakeMetrics.failWrites();
    await addOwner(9009);

    await telegramWebhook(
      textUpdate({ fromUserId: 9009, text: "One", messageId: 1 })
    );
    await telegramWebhook(
      textUpdate({ fromUserId: 9009, text: "Two", messageId: 2 })
    );

    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(2), {
      timeout: 10_000,
    });
  });

  it("records nothing for an update that is not a text message", async () => {
    await telegramWebhook({ update_id: 1, edited_message: {} });

    expect(fakeMetrics.dataPoints).toHaveLength(0);
  });
});
