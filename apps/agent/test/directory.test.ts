import { env } from "cloudflare:test";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { telegramIdentity } from "../src/directory/channel-identity.ts";
import { Directory } from "../src/directory/directory.ts";
import { addOwnerRequest } from "./telegram-requests.ts";

const inDirectory = <A, E>(effect: Effect.Effect<A, E, Directory>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Directory.layer(env.DIRECTORY)))
  );

const findOwner = (telegramUserId: number) =>
  inDirectory(
    Directory.pipe(
      Effect.flatMap((directory) =>
        directory.findOwner(telegramIdentity(telegramUserId))
      )
    )
  );

describe("Operator adds the Owner", () => {
  it("adds the Owner and the Channel Identity through the Directory, and Registration stays closed", async () => {
    const response = await addOwnerRequest(6001);

    expect(response.status).toBe(201);
    const body = await response.json<Record<string, string>>();
    expect(body).toMatchObject({
      channelIdentity: "telegram:6001",
      registration: "closed",
    });
    expect(await findOwner(6001)).toEqual(
      Option.some({ ownerId: body.ownerId, status: "active" })
    );
    expect(
      await inDirectory(
        Directory.pipe(
          Effect.flatMap((directory) => directory.registrationState)
        )
      )
    ).toBe("closed");
  });

  it("refuses a request without the Operator token and stores nothing", async () => {
    const withoutToken = await addOwnerRequest(6002, null);
    const withWrongToken = await addOwnerRequest(6002, "wrong-token");

    expect(withoutToken.status).toBe(401);
    expect(withWrongToken.status).toBe(401);

    expect(await findOwner(6002)).toEqual(Option.none());
  });

  it("refuses a Channel Identity that already belongs to an Owner", async () => {
    const first = await addOwnerRequest(6003);
    const second = await addOwnerRequest(6003);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    const owners = await env.DIRECTORY.prepare(
      "SELECT COUNT(*) AS count FROM channel_identities WHERE channel_identity = 'telegram:6003'"
    ).first<{ count: number }>();
    expect(owners?.count).toBe(1);
  });
});
