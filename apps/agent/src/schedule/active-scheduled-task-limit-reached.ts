import { Data } from "effect";

export class ActiveScheduledTaskLimitReached extends Data.TaggedError(
  "ActiveScheduledTaskLimitReached"
)<{
  readonly limit: number;
}> {}

export const scheduledTaskLimitMessage = (limit: number) =>
  `The Owner already has ${limit} active Scheduled Tasks, which is the limit, so no Scheduled Task was set. Tell the Owner. Ask which Scheduled Task to cancel, then cancel it and set the new one.`;
