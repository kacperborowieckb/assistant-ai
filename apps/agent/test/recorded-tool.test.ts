import { env, runInDurableObject } from "cloudflare:test";
import { Effect, Option, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { runToolEffect, ToolFailed } from "../src/model-gateway/agent-tool.ts";
import type { AgentTool } from "../src/model-gateway/agent-tool.ts";
import {
  captureNoteTool,
  captureNoteToolName,
} from "../src/notes/capture-note-tool.ts";
import { Notes } from "../src/notes/notes.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { recordedTool } from "../src/personal-agent/recorded-tool.ts";
import { TurnProgress } from "../src/personal-agent/turn-progress.ts";
import { Redactor, redactedMark } from "../src/tracing/redactor.ts";
import { resetFakes } from "./fakes.ts";
import { addOwner } from "./telegram-requests.ts";

const eventId = "event-1";
const failureMessage = "The word was not kept. Tell the Owner.";

type KeepWord = (
  word: string
) => Effect.Effect<{ readonly kept: string }, ToolFailed>;

const WordInput = Schema.Struct({ word: Schema.String });

const call = (
  tool: AgentTool,
  { input, toolCallId }: { input: unknown; toolCallId: string }
) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(
        tool
          .toAiSdkTool(runToolEffect(Effect.runPromise))
          .execute?.(input, { toolCallId, messages: [], context: {} })
      ),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

const inRecordedTool = async <A>(
  ownerId: string,
  run: (tools: {
    readonly progress: TurnProgress["Service"];
    readonly toolOf: (work: KeepWord) => AgentTool;
  }) => Effect.Effect<A, unknown>
) =>
  runInDurableObject(
    await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
    (instance) =>
      instance.runtime.runPromise(
        Effect.gen(function* inRecordedToolEffect() {
          const progress = yield* TurnProgress;
          const redactor = yield* Redactor;
          const toolOf = (work: KeepWord) =>
            recordedTool(
              { eventId, progress, redactor },
              {
                name: "keep_word",
                description: "Keep a word",
                inputSchema: WordInput,
                failureMessage,
                work: ({ word }) => work(word),
              }
            );
          return yield* run({ progress, toolOf });
        }).pipe(Effect.provide(Redactor.layer([env.AI_GATEWAY_TOKEN])))
      )
  );

const recordedMessages = (progress: TurnProgress["Service"]) =>
  progress.completedFor(eventId);

beforeEach(() => {
  resetFakes();
});

describe("Recorded tool", () => {
  it("marks the model step, runs the work, and records the call and its result", async () => {
    const ownerId = await addOwner(9501);
    const outcome = await inRecordedTool(ownerId, ({ progress, toolOf }) =>
      Effect.gen(function* successEffect() {
        const result = yield* call(
          toolOf((word) => Effect.succeed({ kept: word })),
          { input: { word: "red" }, toolCallId: "call-1" }
        );
        return {
          result,
          recorded: yield* recordedMessages(progress),
          steps: yield* progress.usedStepCount(eventId),
        };
      })
    );

    expect(outcome.result).toEqual({ kept: "red" });
    expect(outcome.steps).toBe(1);
    expect(outcome.recorded).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "keep_word",
            input: { word: "red" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "keep_word",
            output: { type: "json", value: { kept: "red" } },
          },
        ],
      },
    ]);
  });

  it("keeps the ToolFailed message of the work and records nothing", async () => {
    const ownerId = await addOwner(9502);
    const outcome = await inRecordedTool(ownerId, ({ progress, toolOf }) =>
      Effect.gen(function* toolFailedEffect() {
        const failure = yield* call(
          toolOf(() =>
            Effect.fail(new ToolFailed({ message: "The store is full" }))
          ),
          { input: { word: "red" }, toolCallId: "call-1" }
        ).pipe(Effect.flip);
        return { failure, recorded: yield* recordedMessages(progress) };
      })
    );

    expect(outcome.failure.message).toBe("The store is full");
    expect(outcome.recorded).toEqual([]);
  });

  it("maps a defect of the work to ToolFailed with the failure message", async () => {
    const ownerId = await addOwner(9503);
    const outcome = await inRecordedTool(ownerId, ({ progress, toolOf }) =>
      Effect.gen(function* defectEffect() {
        const failure = yield* call(
          toolOf(() => Effect.die(new Error("disk exploded"))),
          { input: { word: "red" }, toolCallId: "call-1" }
        ).pipe(Effect.flip);
        return { failure, recorded: yield* recordedMessages(progress) };
      })
    );

    expect(outcome.failure.message).toBe(failureMessage);
    expect(outcome.failure.message).not.toContain("disk exploded");
    expect(outcome.recorded).toEqual([]);
  });

  it("writes once when the same call runs again after a crash", async () => {
    const ownerId = await addOwner(9504);
    const outcome = await runInDurableObject(
      await personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId)),
      (instance) =>
        instance.runtime.runPromise(
          Effect.gen(function* repeatedEffect() {
            const notes = yield* Notes;
            const progress = yield* TurnProgress;
            const redactor = yield* Redactor;
            const source = {
              eventId,
              channel: "telegram",
              conversationId: "1",
              channelMessageId: "1",
              trustLevel: "owner",
            } as const;
            const crashing = recordedTool(
              { eventId, progress, redactor },
              {
                name: captureNoteToolName,
                description: "Keep a Note, then crash",
                inputSchema: WordInput,
                failureMessage,
                work: ({ word }) =>
                  notes
                    .capture({ text: word, source })
                    .pipe(Effect.andThen(Effect.die(new Error("crash")))),
              }
            );
            const input = { text: "red" };
            const tool = captureNoteTool(
              {
                notes,
                progress,
                redactor,
                ownerTimeZone: Effect.succeed(Option.none()),
              },
              source
            );
            yield* call(crashing, {
              input: { word: "red" },
              toolCallId: "call-1",
            }).pipe(Effect.flip);
            const keptAfterCrash = (yield* notes.list).length;
            yield* call(tool, { input, toolCallId: "call-1" });
            const repeated = yield* call(tool, { input, toolCallId: "call-1" });
            return {
              keptAfterCrash,
              repeated,
              kept: (yield* notes.list).length,
              steps: yield* progress.usedStepCount(eventId),
            };
          }).pipe(Effect.provide(Redactor.layer([env.AI_GATEWAY_TOKEN])))
        )
    );

    expect(outcome.keptAfterCrash).toBe(0);
    expect(outcome.kept).toBe(1);
    expect(outcome.repeated).toMatchObject({ alreadyKept: true });
    expect(outcome.steps).toBe(1);
  });

  it("redacts a secret in the recorded input and output", async () => {
    const ownerId = await addOwner(9505);
    const outcome = await inRecordedTool(ownerId, ({ progress, toolOf }) =>
      Effect.gen(function* redactionEffect() {
        yield* call(
          toolOf((word) => Effect.succeed({ kept: word })),
          { input: { word: env.AI_GATEWAY_TOKEN }, toolCallId: "call-1" }
        );
        return { recorded: yield* recordedMessages(progress) };
      })
    );

    expect(JSON.stringify(outcome.recorded)).not.toContain(
      env.AI_GATEWAY_TOKEN
    );
    expect(JSON.stringify(outcome.recorded)).toContain(redactedMark);
  });
});
