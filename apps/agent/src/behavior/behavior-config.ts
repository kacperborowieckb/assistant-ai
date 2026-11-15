export interface BehaviorConfig {
  readonly textingStyle: string;
  readonly maxToolSteps: number;
}

export const defaultBehaviorConfig: BehaviorConfig = {
  textingStyle:
    "Write like a person who texts: short messages in plain text. Do not use markdown, headings, or lists.",
  maxToolSteps: 8,
};
