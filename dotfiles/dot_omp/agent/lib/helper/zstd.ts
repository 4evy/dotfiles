import { addAbortSignal, Transform, type TransformCallback } from "node:stream";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";

const HEADER_BYTES = 8;
const ZSTD_MAGIC = 0xfd2fb528;

// Each JSONL message is an independent zstd frame, so interactive replies flush
// immediately instead of waiting for a long-lived compressor to fill its buffer
async function transcode(
  input: Buffer,
  decode: boolean,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const codec = addAbortSignal(
    signal,
    decode
      ? createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: 26 } })
      : createZstdCompress(),
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  codec.end(input);
  for await (const chunk of codec) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("zstd transport exceeds byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

class FrameTransform extends Transform {
  protected readonly abort = new AbortController();
  private demand: PromiseWithResolvers<void> | undefined;
  protected async pushFrame(chunk: Buffer): Promise<void> {
    this.abort.signal.throwIfAborted();
    const demand = Promise.withResolvers<void>();
    this.demand = demand;
    if (this.push(chunk)) this.demand = undefined;
    else await demand.promise;
  }
  override _read(size: number) {
    this.demand?.resolve();
    this.demand = undefined;
    super._read(size);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.abort.abort(error ?? new Error("Helper transport closed"));
    this.demand?.reject(this.abort.signal.reason);
    this.demand = undefined;
    callback(error);
  }
}

export class ZstdFrames extends FrameTransform {
  private pieces: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    void this.encode(chunk).then(() => callback(), callback);
  }
  private async encode(chunk: Buffer) {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, end + 1);
      if (this.bytes + piece.length > this.limit + 1)
        throw new Error("Helper frame exceeds byte limit");
      this.pieces.push(piece);
      this.bytes += piece.length;
      const raw = Buffer.concat(this.pieces, this.bytes);
      this.pieces = [];
      this.bytes = 0;
      const compressed = await transcode(
        raw,
        false,
        this.limit + 131072,
        this.abort.signal,
      );
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      header.writeUInt32BE(compressed.length, 0);
      header.writeUInt32BE(raw.length, 4);
      await this.pushFrame(header);
      await this.pushFrame(compressed);
      start = end + 1;
    }
    if (start < chunk.length) {
      const piece = chunk.subarray(start);
      this.bytes += piece.length;
      if (this.bytes > this.limit) throw new Error("Helper frame exceeds byte limit");
      this.pieces.push(piece);
    }
  }
  override _flush(callback: TransformCallback) {
    callback(this.bytes ? new Error("Truncated helper JSONL frame") : undefined);
  }
}

export class UnzstdFrames extends FrameTransform {
  private header = Buffer.alloc(HEADER_BYTES);
  private headerBytes = 0;
  private pieces: Buffer[] = [];
  private bytes = 0;
  private compressedBytes = 0;
  private rawBytes = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    void this.decode(chunk).then(() => callback(), callback);
  }
  private async decode(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.headerBytes < HEADER_BYTES) {
        const count = Math.min(HEADER_BYTES - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < HEADER_BYTES) continue;
        this.compressedBytes = this.header.readUInt32BE(0);
        this.rawBytes = this.header.readUInt32BE(4);
        if (
          this.compressedBytes < 4 ||
          this.compressedBytes > this.limit + 131072 ||
          this.rawBytes < 1 ||
          this.rawBytes > this.limit + 1
        ) {
          throw new Error("Invalid zstd helper frame length");
        }
      }
      const count = Math.min(this.compressedBytes - this.bytes, chunk.length - offset);
      this.pieces.push(chunk.subarray(offset, offset + count));
      this.bytes += count;
      offset += count;
      if (this.bytes !== this.compressedBytes) continue;
      const encoded = Buffer.concat(this.pieces, this.bytes);
      if (encoded.readUInt32LE(0) !== ZSTD_MAGIC)
        throw new Error("Expected zstd helper frame");
      const raw = await transcode(encoded, true, this.rawBytes, this.abort.signal);
      if (
        raw.length !== this.rawBytes ||
        raw[raw.length - 1] !== 10 ||
        raw.subarray(0, -1).includes(10)
      ) {
        throw new Error("Invalid decoded helper JSONL frame");
      }
      await this.pushFrame(raw);
      this.headerBytes = 0;
      this.pieces = [];
      this.bytes = 0;
    }
  }
  override _flush(callback: TransformCallback) {
    callback(
      this.headerBytes || this.bytes
        ? new Error("Truncated zstd helper frame")
        : undefined,
    );
  }
}
