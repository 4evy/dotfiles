import { spawn } from "node:child_process";
import { pipeline } from "node:stream";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "../desktop/protocol";
import { BoundedFrames } from "./bounds";
import { UnzstdFrames, ZstdFrames } from "./zstd";

const argv = process.argv.slice(2);
const compressed = argv[0] === "--wire-codec=zstd";
if (compressed) argv.shift();
const [command, ...args] = argv;
if (!command) throw new Error("Missing helper relay command");
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
let stopping = false;
function stop(error?: Error | null) {
  if (stopping) return;
  stopping = true;
  if (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.message}\n`);
  }
  child.stdin.destroy();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  timer.unref();
}
if (compressed) {
  pipeline(
    process.stdin,
    new BoundedFrames(MAX_REQUEST_BYTES),
    new ZstdFrames(MAX_REQUEST_BYTES),
    child.stdin,
    stop,
  );
  pipeline(
    child.stdout,
    new UnzstdFrames(MAX_RESPONSE_BYTES),
    new BoundedFrames(MAX_RESPONSE_BYTES),
    process.stdout,
    stop,
  );
} else {
  pipeline(process.stdin, new BoundedFrames(MAX_REQUEST_BYTES), child.stdin, stop);
  pipeline(child.stdout, new BoundedFrames(MAX_RESPONSE_BYTES), process.stdout, stop);
}
child.on("error", stop);
child.on("exit", (code) => {
  process.exitCode = process.exitCode || code || (code === 0 ? 0 : 1);
  process.stdin.destroy();
});
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
