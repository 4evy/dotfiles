#!/usr/bin/env bun
import { downloadFile } from "./source.ts";

const [lock, name, destination, ...extra] = Bun.argv.slice(2);
if (!lock || !name || !destination || extra.length) {
  console.error("Usage: bun download.ts LOCK NAME DESTINATION");
  process.exit(2);
}
const data: unknown = await Bun.file(lock).json();
if (typeof data !== "object" || data === null || !("pins" in data)) {
  throw new Error("Source lock must contain pins");
}
const pins = data.pins;
if (typeof pins !== "object" || pins === null || !(name in pins)) {
  throw new Error(`Source lock has no pin named ${name}`);
}
const pin: unknown = Reflect.get(pins, name);
if (
  typeof pin !== "object" ||
  pin === null ||
  !("url" in pin) ||
  typeof pin.url !== "string" ||
  !("narHash" in pin) ||
  typeof pin.narHash !== "string"
) {
  throw new Error(`Source pin ${name} must contain url and narHash strings`);
}
await downloadFile({ url: pin.url, narHash: pin.narHash }, destination);
