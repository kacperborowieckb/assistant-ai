import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { OwnerPreferences } from "./owner-preferences.ts";
import {
  maxProactiveMessageBudget,
  ProactiveMessageBudgetSchema,
} from "./proactive-message-budget.ts";

export const proactiveMessageBudgetToolName = "proactive_message_budget";

export const proactiveMessageBudgetNotChangedMessage =
  "The Budget was not changed. Tell the Owner that you could not change it.";

export const invalidProactiveMessageBudgetMessage = `The Budget was not changed. Give sends as a whole number from 0 to ${maxProactiveMessageBudget}.`;

export interface ProactiveMessageBudgetToolServices {
  readonly preferences: OwnerPreferences["Service"];
  readonly defaultSends: number;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

const ProactiveMessageBudgetInput = Schema.Struct({
  sends: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.annotate({
        description:
          "How many Proactive Messages you may send in one local day of the Owner. Give it to change the Budget; leave it out to read the Budget.",
      })
    )
  ),
});

export const proactiveMessageBudgetTool = (
  {
    preferences,
    defaultSends,
    progress,
    redactor,
  }: ProactiveMessageBudgetToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: proactiveMessageBudgetToolName,
      description:
        "Read or change the Budget of the Owner: the most Proactive Messages that you send in one local day. Call it with no input to read it. To change it, give sends as a whole number. For example, when the Owner says to message them at most twice a day, give sends 2. A Proactive Message over the Budget is not sent alone: it goes into the next Brief. The Brief still comes. Reminders and Scheduled Tasks that the Owner set do not count. It returns the Budget, its source (owner or default), and whether it changed.",
      inputSchema: ProactiveMessageBudgetInput,
      failureMessage: proactiveMessageBudgetNotChangedMessage,
      work: Effect.fnUntraced(function* budgetEffect({ sends }) {
        if (sends === undefined) {
          const current =
            yield* preferences.proactiveMessageBudget(defaultSends);
          return { ...current, changed: false };
        }
        if (!Schema.is(ProactiveMessageBudgetSchema)(sends)) {
          return yield* new ToolFailed({
            message: invalidProactiveMessageBudgetMessage,
          });
        }
        return yield* preferences.setProactiveMessageBudget(
          sends,
          defaultSends,
          eventId
        );
      }),
    }
  );
