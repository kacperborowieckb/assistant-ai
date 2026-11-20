import { Effect, Option, Schema } from "effect";

import type { AgentStorage } from "../personal-agent/agent-storage.ts";
import type {
  OwnerPreferenceSource,
  PreferenceWrite,
  StoredOwnerPreference,
} from "./owner-preferences.ts";

export const maxProactiveMessageBudget = 24;

export const ProactiveMessageBudgetSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maxProactiveMessageBudget })
);

export interface EffectiveProactiveMessageBudget {
  readonly sends: number;
  readonly source: OwnerPreferenceSource | "default";
}

export interface ProactiveMessageBudgetChange extends EffectiveProactiveMessageBudget {
  readonly changed: boolean;
}

interface BudgetPreferenceStore<ReadError, WriteError> {
  readonly database: AgentStorage["Service"]["database"];
  readonly readStored: (
    key: "proactive_message_budget"
  ) => Effect.Effect<
    Option.Option<StoredOwnerPreference<"proactive_message_budget">>,
    ReadError
  >;
  readonly write: (
    request: PreferenceWrite<"proactive_message_budget">
  ) => Effect.Effect<void, WriteError>;
}

export const makeProactiveMessageBudgetPreference = <ReadError, WriteError>({
  database,
  readStored,
  write,
}: BudgetPreferenceStore<ReadError, WriteError>) => {
  const proactiveMessageBudget = (defaultSends: number) =>
    readStored("proactive_message_budget").pipe(
      Effect.map(
        Option.match({
          onNone: (): EffectiveProactiveMessageBudget => ({
            sends: defaultSends,
            source: "default",
          }),
          onSome: ({ value, source }): EffectiveProactiveMessageBudget => ({
            sends: value,
            source,
          }),
        })
      )
    );

  const writeProactiveMessageBudget = Effect.fnUntraced(
    function* writeProactiveMessageBudget(
      requested: number,
      defaultSends: number,
      eventId: string
    ) {
      const current = yield* proactiveMessageBudget(defaultSends);
      if (current.source !== "default" && current.sends === requested) {
        return {
          ...current,
          changed: false,
        } satisfies ProactiveMessageBudgetChange;
      }
      yield* write({
        key: "proactive_message_budget",
        value: requested,
        journalValue: String(requested),
        eventId,
        source: "owner",
      });
      return {
        sends: requested,
        source: "owner",
        changed: true,
      } satisfies ProactiveMessageBudgetChange;
    }
  );

  const setProactiveMessageBudget = (
    requested: number,
    defaultSends: number,
    eventId: string
  ) =>
    database.transaction(() =>
      writeProactiveMessageBudget(requested, defaultSends, eventId)
    );

  return { proactiveMessageBudget, setProactiveMessageBudget };
};
