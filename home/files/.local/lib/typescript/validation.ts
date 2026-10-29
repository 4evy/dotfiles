import { Schema } from "effect";

export const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
