import type { DateTime } from "effect";

import { isSameOpenLoop } from "./open-loop.ts";
import type { OpenLoop, OpenLoopOpen } from "./open-loop.ts";

export interface OpenLoopRequest {
  readonly kind: string;
  readonly dueAt?: DateTime.Utc | undefined;
}

export interface OpenLoopChange {
  readonly openLoop: OpenLoopOpen;
  readonly record: "OpenLoopOpened" | "OpenLoopChanged";
}

export const openOpenLoopOf = ({
  kind,
  dueAt,
}: OpenLoopRequest): OpenLoopOpen => ({
  _tag: "Open",
  kind,
  ...(dueAt === undefined ? {} : { dueAt }),
});

export const openLoopChangeOf = (
  current: OpenLoop | undefined,
  request: OpenLoopRequest
): OpenLoopChange | undefined => {
  const openLoop = openOpenLoopOf(request);
  if (current?._tag !== "Open") {
    return { openLoop, record: "OpenLoopOpened" };
  }
  return isSameOpenLoop(current, openLoop)
    ? undefined
    : { openLoop, record: "OpenLoopChanged" };
};
