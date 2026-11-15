import { Schema } from "effect";

export const ownerLabels = ["A", "B"] as const;

export const OwnerLabelSchema = Schema.Literals(ownerLabels);

export type OwnerLabel = typeof OwnerLabelSchema.Type;

export const defaultOwnerLabel: OwnerLabel = "A";

export const ownerLabelOf = (item: { readonly owner?: OwnerLabel }) =>
  item.owner ?? defaultOwnerLabel;
