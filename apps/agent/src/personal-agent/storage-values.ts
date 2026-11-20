export const eventKinds = ["OwnerMessage", "ScheduleFired"] as const;

export const inboxStates = ["pending", "done", "failed"] as const;

export const trustLevels = ["owner", "untrusted"] as const;

export const noteChanges = ["text", "links", "text_and_links"] as const;

export const openLoopStates = ["open", "closed"] as const;

export const openLoopClosedReasons = ["done", "dropped", "replaced"] as const;

export const profileEntryKinds = ["fact", "style_rule"] as const;

export const ownerPreferenceKeys = ["time_zone", "quiet_hours"] as const;

export const ownerPreferenceSources = ["owner"] as const;

export const turnResults = [
  "model_replied",
  "model_failed",
  "reminder_delivered",
  "reminder_delivery_failed",
  "scheduled_task_replied",
  "scheduled_task_failed",
  "scheduled_task_skipped",
  "proactive_message_sent",
  "proactive_message_failed",
  "proactive_message_held",
] as const;

export const scheduleActions = ["send_text", "run_prompt"] as const;

export const scheduleSetBy = ["owner", "agent"] as const;

export const scheduleStates = ["active", "done", "cancelled"] as const;

export const modelTasks = [
  "reply",
  "scheduled_task",
  "proactive",
  "eval_judge",
] as const;

export const proactiveOutcomes = [
  "acted",
  "replied",
  "muted",
  "ignored",
] as const;

export const proactiveHoldReasons = ["quiet_hours"] as const;

export type ProactiveOutcome = (typeof proactiveOutcomes)[number];
