export interface BehaviorConfig {
  readonly textingStyle: string;
  readonly maxToolSteps: number;
  readonly maxProfileCharacters: number;
  readonly reminderGraceMillis: number;
  readonly scheduledTaskDailyTokenBudget: number;
  readonly maxActiveScheduledTasks: number;
  readonly proactiveDailyTokenBudget: number;
  readonly proactiveResponseWindowMillis: number;
  readonly quietHours: { readonly start: string; readonly end: string };
  readonly defaultTimeZone?: string | undefined;
}

export const defaultBehaviorConfig: BehaviorConfig = {
  textingStyle:
    "Write like a person who texts: short messages in plain text. Do not use markdown, headings, or lists.",
  maxToolSteps: 8,
  maxProfileCharacters: 2000,
  reminderGraceMillis: 5 * 60 * 1000,
  scheduledTaskDailyTokenBudget: 200_000,
  maxActiveScheduledTasks: 10,
  proactiveDailyTokenBudget: 200_000,
  proactiveResponseWindowMillis: 24 * 60 * 60 * 1000,
  quietHours: { start: "22:00", end: "08:00" },
};
