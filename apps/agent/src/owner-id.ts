import { Schema } from "effect";

export const OwnerIdSchema = Schema.String.pipe(Schema.brand("OwnerId"));

export type OwnerId = typeof OwnerIdSchema.Type;
