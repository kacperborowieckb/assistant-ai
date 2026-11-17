export const scheduledTaskMarker = "The Owner is not present.";

export const scheduledTaskSection = (setAt: string) =>
  [
    `${scheduledTaskMarker} This work comes from a Schedule that the Owner set at ${setAt}. It is due now.`,
    "The stored prompt is your only input. Do the work with your read tools only. You can search and read Notes and list Schedules. You cannot change anything.",
    "Your answer goes to the Owner as one message. Write it as a message to the Owner. Do not ask a question that needs a reply to finish the work.",
  ].join(" ");
