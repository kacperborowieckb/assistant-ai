import { Schema } from "effect";

export const ProactiveMutesSchema = Schema.Struct({
  openLoopIds: Schema.Array(Schema.String),
  kinds: Schema.Array(Schema.String),
});

export type ProactiveMutes = typeof ProactiveMutesSchema.Type;

export const noProactiveMutes: ProactiveMutes = { openLoopIds: [], kinds: [] };

export const normalizeKind = (kind: string) => kind.trim().toLowerCase();

interface MutableOpenLoop {
  readonly noteId: string;
  readonly openLoop: { readonly kind: string } | undefined;
}

export const isMuted = (mutes: ProactiveMutes, note: MutableOpenLoop) =>
  mutes.openLoopIds.includes(note.noteId) ||
  (note.openLoop !== undefined &&
    mutes.kinds.includes(normalizeKind(note.openLoop.kind)));

const union = (current: readonly string[], added: readonly string[]) => [
  ...new Set([...current, ...added]),
];

const without = (current: readonly string[], removed: readonly string[]) =>
  current.filter((value) => !removed.includes(value));

export const withMutes = (
  mutes: ProactiveMutes,
  targets: ProactiveMutes
): ProactiveMutes => ({
  openLoopIds: union(mutes.openLoopIds, targets.openLoopIds),
  kinds: union(mutes.kinds, targets.kinds.map(normalizeKind)),
});

export const withoutMutes = (
  mutes: ProactiveMutes,
  targets: ProactiveMutes
): ProactiveMutes => ({
  openLoopIds: without(mutes.openLoopIds, targets.openLoopIds),
  kinds: without(mutes.kinds, targets.kinds.map(normalizeKind)),
});

export const sameMutes = (left: ProactiveMutes, right: ProactiveMutes) =>
  left.openLoopIds.length === right.openLoopIds.length &&
  left.kinds.length === right.kinds.length &&
  left.openLoopIds.every((id) => right.openLoopIds.includes(id)) &&
  left.kinds.every((kind) => right.kinds.includes(kind));
