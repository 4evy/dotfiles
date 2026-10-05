import { Transform, type TransformCallback } from "node:stream";
import { MAX_REQUEST_BYTES } from "../desktop/protocol";

// Bound each SDK JSONL frame before any downstream JSON decoder receives it
export class BoundedFrames extends Transform {
  private bytes = 0;
  constructor(
    private readonly limit: number,
    private readonly errorMessage = "Helper frame exceeds byte limit",
  ) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.bytes += index - start;
      if (this.bytes > this.limit) return callback(new Error(this.errorMessage));
      this.bytes = 0;
      start = index + 1;
    }
    this.bytes += chunk.length - start;
    if (this.bytes > this.limit) return callback(new Error(this.errorMessage));
    callback(null, chunk);
  }
}

export function boundRequest(name: string, args: Record<string, unknown>): void {
  // Reserve space for the JSON-RPC envelope and generated request identifier
  if (
    Buffer.byteLength(JSON.stringify({ name, arguments: args })) >
    MAX_REQUEST_BYTES - 1024
  ) {
    throw new Error("Helper request exceeds 1 MiB limit");
  }
}
