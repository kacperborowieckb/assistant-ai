import { Cause, Effect, Option, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { profileEntryKinds } from "../personal-agent/storage-schema.ts";
import { ProfileFull } from "./profile-full.ts";
import type { ProfileToolServices } from "./profile-tool-services.ts";
import { UnknownProfileEntry } from "./unknown-profile-entry.ts";

export const updateProfileToolName = "update_profile";

export const profileNotChangedMessage =
  "The Profile was not changed. Tell the Owner that you could not change it.";

export const profileEntryMissingFieldMessage = {
  add: "The Profile was not changed. To add an entry, give its kind and its text.",
  remove:
    "The Profile was not changed. To remove an entry, give its entry id from the Profile.",
} as const;

const NonBlank = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/u)));

const UpdateProfileInput = Schema.Struct({
  action: Schema.Literals(["add", "remove"]).pipe(
    Schema.annotate({ description: "Add one entry or remove one entry." })
  ),
  kind: Schema.optionalKey(
    Schema.Literals(profileEntryKinds).pipe(
      Schema.annotate({
        description:
          "For add: fact for a core fact about the Owner, style_rule for how the Owner wants you to write or act.",
      })
    )
  ),
  text: Schema.optionalKey(
    NonBlank.pipe(
      Schema.annotate({
        description:
          "For add: one short entry, in the words of the Owner. One fact or one rule.",
      })
    )
  ),
  entryId: Schema.optionalKey(
    NonBlank.pipe(
      Schema.annotate({
        description:
          "For remove: the entry id of the entry, as the Profile in the system prompt shows it.",
      })
    )
  ),
});

const failureMessageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) {
    return profileNotChangedMessage;
  }
  if (error.value instanceof ProfileFull) {
    return `The Profile is full: it has ${error.value.charactersUsed} of ${error.value.characterLimit} characters. Nothing was added. Tell the Owner that the Profile is full and that they can ask you to remove an entry first.`;
  }
  if (error.value instanceof UnknownProfileEntry) {
    return `The Profile has no entry with the id ${error.value.entryId}. Nothing was removed. Use an entry id from the Profile.`;
  }
  return profileNotChangedMessage;
};

export const updateProfileTool = (
  { profile, progress, redactor, characterLimit }: ProfileToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: updateProfileToolName,
      description:
        "Add or remove one entry of the Profile: a core fact or a style rule about the Owner. The Profile is in every Turn, so keep only what the Owner states about themselves or asks for, and keep it short. Fails when the Profile has no room.",
      inputSchema: UpdateProfileInput,
      failureMessage: failureMessageOf,
      work: Effect.fnUntraced(function* updateProfileEffect({
        action,
        kind,
        text,
        entryId,
      }) {
        if (action === "add") {
          if (kind === undefined || text === undefined) {
            return yield* new ToolFailed({
              message: profileEntryMissingFieldMessage.add,
            });
          }
          const { entry, alreadyKept, charactersUsed } = yield* profile.add({
            kind,
            text: text.trim(),
            eventId,
            characterLimit,
          });
          return {
            entryId: entry.entryId,
            kind: entry.kind,
            text: entry.text,
            alreadyKept,
            charactersUsed,
            characterLimit,
          };
        }
        if (entryId === undefined) {
          return yield* new ToolFailed({
            message: profileEntryMissingFieldMessage.remove,
          });
        }
        const entry = yield* profile.remove({ entryId, eventId });
        return { entryId: entry.entryId, removed: true };
      }),
    }
  );
