import { DAEMON_OUTPUT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { terminal } from "./broker";
import { hasTerminalRedraw } from "./output";
import type { DeliveryRecord, Logs } from "./types";

const UTF8_WIDTHS = [
  { first: 0xc2, last: 0xdf, width: 2 },
  { first: 0xe0, last: 0xef, width: 3 },
  { first: 0xf0, last: 0xf4, width: 4 },
] as const;
const MAX_UTF8_WIDTH = 4;

export interface OutputRead {
  bytes: Uint8Array;
  startCursor: number;
  cursor: number;
  availableEnd: number;
  availableStart: number;
  requestedCursor: number;
  replay: boolean;
  lines: number;
}

function incompleteUtf8Tail(bytes: Uint8Array): number {
  let pendingLength = 0;
  if (bytes.length) {
    let index = bytes.length - 1;
    while (
      index >= Math.max(0, bytes.length - MAX_UTF8_WIDTH) &&
      ((bytes[index] ?? 0) & 0xc0) === 0x80
    )
      index--;
    const lead = bytes[index] ?? 0;
    const width =
      UTF8_WIDTHS.find(({ first, last }) => lead >= first && lead <= last)?.width ?? 1;
    if (index >= 0 && width > bytes.length - index)
      pendingLength = bytes.length - index;
  }
  return pendingLength;
}

export function decodeOutput(
  delivery: DeliveryRecord,
  read: OutputRead | undefined,
  daemon: DaemonSnapshot,
  logs: Logs,
): { logs: Logs; pending: string | undefined; redrawing: boolean } {
  if (!read) {
    // Caller-provided snapshots are safe for screens, never for unread log replay
    const unread = logs.cursor > (delivery.outputCursor ?? 0);
    return {
      logs: {
        ...logs,
        text: unread ? logs.text : "",
        rawText: unread ? logs.rawText : "",
      },
      pending: undefined,
      redrawing: delivery.terminalRedraw ?? false,
    };
  }
  const cursor = read.replay ? read.requestedCursor : (delivery.outputCursor ?? 0);
  const gap =
    read.startCursor > cursor && read.cursor > cursor
      ? cursor < read.availableStart
        ? `[Output before byte ${read.availableStart} is no longer retained; this view starts at byte ${read.startCursor}]\n`
        : `[Earlier unread output omitted; this view starts at byte ${read.startCursor}]\n`
      : "";
  const offset = Math.max(0, cursor - read.startCursor);
  let bytes = read.bytes.subarray(offset);
  const continuing = cursor === delivery.outputCursor && cursor >= read.startCursor;
  if (continuing && delivery.decoderPending && read.cursor >= cursor)
    bytes = Buffer.concat([Buffer.from(delivery.decoderPending, "base64"), bytes]);
  const streaming = !terminal(daemon) || read.cursor < read.availableEnd;
  const pendingLength = streaming ? incompleteUtf8Tail(bytes) : 0;
  const text = new TextDecoder("utf-8", {
    ignoreBOM: cursor > 0 || read.startCursor > 0,
  }).decode(bytes.subarray(0, bytes.length - pendingLength));
  const pending = pendingLength
    ? Buffer.from(bytes.subarray(bytes.length - pendingLength)).toString("base64")
    : undefined;
  const rawTail = truncateTail(text, {
    maxLines: read.lines,
    maxBytes: DAEMON_OUTPUT_MAX_BYTES,
  }).content;
  const plain = sanitizeText(text);
  const plainTail = truncateTail(plain, {
    maxLines: read.lines,
    maxBytes: DAEMON_OUTPUT_MAX_BYTES,
  }).content;
  const truncation =
    rawTail !== text || plainTail !== plain
      ? "[Earlier unread output omitted by the response limit]\n"
      : "";
  const rawText = gap + truncation + rawTail;
  return {
    logs: {
      ...logs,
      text: gap + truncation + plainTail,
      rawText,
      ...(gap || truncation ? { outputGap: gap + truncation } : {}),
    },
    pending,
    redrawing: Boolean(delivery.terminalRedraw || hasTerminalRedraw(text)),
  };
}
