import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DotfilesError } from "@dotfiles/core/errors";
import { validateWrites } from "./store.ts";
import { initializeDatabase } from "./worker.ts";

const daemon = "/System/Library/PrivateFrameworks/TCC.framework/Support/tccd";
const workerTimeoutMs = 15_000;
const scratchDirectoryMode = 0o700;
const bundleFileMode = 0o600;

// Field offsets and struct sizes from the SDK's mach-o headers
const fatHeader = { magic: 0, archCount: 4, size: 8 };
const fatArch = { cpuType: 0, cpuSubtype: 4, fileOffset: 8, fileSize: 12, size: 20 };
const machHeader = {
  magic: 0,
  fileType: 12,
  commandCount: 16,
  commandsSize: 20,
  flags: 24,
  size: 32,
};
const loadCommand = { kind: 0, sizeField: 4, size: 8 };
const segment = { name: 8, sectionCount: 64, size: 72 };
const section = { nameSize: 16, byteSize: 40, fileOffset: 48, flags: 64, size: 80 };
const chainedStartsOffset = 4; // dyld_chained_fixups_header.starts_offset
const linkeditDataOffset = 8; // linkedit_data_command.dataoff
const wordSize = Uint32Array.BYTES_PER_ELEMENT;

const fatMagic = 0xcafebabe;
const mhMagic64 = 0xfeedfacf;
const mhExecute = 2;
const mhBundle = 8;
const mhPie = 0x20_0000;
const arm64 = 0x100_000c;
const arm64e = 2;
const cpuSubtypeWithoutFeatures = 0x00ff_ffff;
const lcSegment64 = 0x19;
const lcMain = 0x8000_0028;
const lcLoadDylinker = 0xe;
const lcDyldChainedFixups = 0x8000_0034;
const lcThread = 0x4;
const lcUnixThread = 0x5;
const lcRoutines = 0x11;
const lcRoutines64 = 0x1a;
const sectionTypeMask = 0xff;
const sectionModInitFuncPointers = 0x9;
const sectionInitFuncOffsets = 0x16;
const pageZeroName = "__PAGEZERO";
const stringTerminator = 0;
const executableOnlyCommandCount = 3; // __PAGEZERO, LC_MAIN, LC_LOAD_DYLINKER
const unsupportedEntryPoints = new Set([
  lcRoutines,
  lcRoutines64,
  lcUnixThread,
  lcThread,
]);

function requireLayout(ok: unknown): asserts ok {
  if (!ok)
    throw new DotfilesError("Unsupported layout for the installed tccd executable");
}

function readArm64eImage() {
  const universal = readFileSync(daemon);
  requireLayout(universal.readUInt32BE(fatHeader.magic) === fatMagic);
  const count = universal.readUInt32BE(fatHeader.archCount);
  requireLayout(fatHeader.size + count * fatArch.size <= universal.length);
  let image: Buffer | undefined;
  for (let i = 0; i < count; i++) {
    const arch = fatHeader.size + i * fatArch.size;
    if (
      universal.readUInt32BE(arch + fatArch.cpuType) !== arm64 ||
      (universal.readUInt32BE(arch + fatArch.cpuSubtype) &
        cpuSubtypeWithoutFeatures) !==
        arm64e
    )
      continue;
    const offset = universal.readUInt32BE(arch + fatArch.fileOffset);
    const size = universal.readUInt32BE(arch + fatArch.fileSize);
    requireLayout(!image && offset + size <= universal.length);
    image = universal.subarray(offset, offset + size);
  }
  requireLayout(
    image &&
      image.readUInt32LE(machHeader.magic) === mhMagic64 &&
      image.readUInt32LE(machHeader.fileType) === mhExecute,
  );
  return image;
}

function findBootstrapSql(strings: Buffer) {
  // TCCDMainDatabase.init passes this SQL to initWithDatabasePath:initialSQL:
  // The unique C-string marker is a heuristic, not a stable Apple interface
  const adminTable = "CREATE TABLE IF NOT EXISTS admin ";
  const accessTable = "CREATE TABLE IF NOT EXISTS access (";
  let ddl: string | undefined;
  for (
    let start = strings.indexOf(adminTable);
    start !== -1;
    start = strings.indexOf(adminTable, start + 1)
  ) {
    if (start !== 0 && strings[start - 1] !== stringTerminator) continue;
    const end = strings.indexOf(stringTerminator, start);
    requireLayout(end > start);
    const candidate = strings.toString("utf8", start, end);
    if (!candidate.includes(accessTable)) continue;
    requireLayout(!ddl);
    ddl = candidate;
  }
  return ddl;
}

function inspectSegment(
  image: Buffer,
  offset: number,
  size: number,
  commandsEnd: number,
) {
  requireLayout(size >= segment.size);
  const count = image.readUInt32LE(offset + segment.sectionCount);
  requireLayout(segment.size + count * section.size === size);
  let ddl: string | undefined;
  for (let i = 0; i < count; i++) {
    const entry = offset + segment.size + i * section.size;
    const [name] = image
      .toString("ascii", entry, entry + section.nameSize)
      .split("\0", 1);
    const type = image.readUInt32LE(entry + section.flags) & sectionTypeMask;
    requireLayout(
      type !== sectionModInitFuncPointers &&
        type !== sectionInitFuncOffsets &&
        name !== "__objc_nlclslist" &&
        name !== "__objc_nlcatlist",
    );
    if (name !== "__cstring") continue;
    const start = image.readUInt32LE(entry + section.fileOffset);
    const length = Number(image.readBigUInt64LE(entry + section.byteSize));
    requireLayout(start >= commandsEnd && start + length <= image.length);
    const candidate = findBootstrapSql(image.subarray(start, start + length));
    if (candidate === undefined) continue;
    requireLayout(!ddl);
    ddl = candidate;
  }
  return ddl;
}

function removePageZeroFixups(image: Buffer, fixups: number, segments: number) {
  const starts = fixups + image.readUInt32LE(fixups + chainedStartsOffset);
  const firstSegment = starts + wordSize;
  const startsEnd = firstSegment + wordSize * segments;
  requireLayout(startsEnd <= image.length);
  requireLayout(
    image.readUInt32LE(starts) === segments && image.readUInt32LE(firstSegment) === 0,
  );
  // dyld_chained_starts_in_image.seg_info_offset is indexed by load-command order
  image.copyWithin(firstSegment, firstSegment + wordSize, startsEnd);
  image.writeUInt32LE(segments - 1, starts);
  image.writeUInt32LE(0, startsEnd - wordSize);
}

function makeInitializerBundle() {
  const image = readArm64eImage();
  const commands = image.readUInt32LE(machHeader.commandCount);
  const end = machHeader.size + image.readUInt32LE(machHeader.commandsSize);
  requireLayout(end <= image.length);
  let fixups = 0;
  let dst = machHeader.size;
  let offset = machHeader.size;
  let segments = 0;
  let ddl: string | undefined;
  const stripped = new Set<number>();
  for (let i = 0; i < commands; i++) {
    requireLayout(offset + loadCommand.size <= end);
    const command = image.readUInt32LE(offset + loadCommand.kind);
    const size = image.readUInt32LE(offset + loadCommand.sizeField);
    requireLayout(size >= loadCommand.size && offset + size <= end);
    // Reject load-time entry points rather than accidentally running daemon setup
    requireLayout(!unsupportedEntryPoints.has(command));
    let pageZero = false;
    if (command === lcSegment64) {
      const sql = inspectSegment(image, offset, size, end);
      if (sql !== undefined) {
        requireLayout(!ddl);
        ddl = sql;
      }
      const name = offset + segment.name;
      pageZero =
        image.toString("ascii", name, name + pageZeroName.length) === pageZeroName;
      requireLayout(!pageZero || segments === 0);
      segments++;
    }
    if (command === lcDyldChainedFixups)
      fixups = image.readUInt32LE(offset + linkeditDataOffset);
    if (pageZero || command === lcMain || command === lcLoadDylinker) {
      requireLayout(!stripped.has(command));
      stripped.add(command);
    } else {
      image.copyWithin(dst, offset, offset + size);
      dst += size;
    }
    offset += size;
  }
  requireLayout(
    ddl &&
      stripped.size === executableOnlyCommandCount &&
      offset === end &&
      fixups >= end &&
      fixups + chainedStartsOffset + wordSize <= image.length,
  );
  removePageZeroFixups(image, fixups, segments);
  image.fill(0, dst, end);
  image.writeUInt32LE(mhBundle, machHeader.fileType);
  image.writeUInt32LE(commands - stripped.size, machHeader.commandCount);
  image.writeUInt32LE(dst - machHeader.size, machHeader.commandsSize);
  image.writeUInt32LE(image.readUInt32LE(machHeader.flags) & ~mhPie, machHeader.flags);
  return { image, ddl };
}

function runWorker(root: string, argv: string[]) {
  const result = Bun.spawnSync(argv, {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: workerTimeoutMs,
  });
  if (result.exitCode !== 0)
    throw new DotfilesError(
      `TCC baseline worker failed (${result.signalCode ?? result.exitCode}): ${result.stderr.toString().trim()}`,
    );
}

export type Baseline = {
  readonly version: number;
  readonly catalog: readonly {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }[];
};

function readCatalog(db: Database): Baseline {
  const version = db
    .query<{ value: number }, []>("SELECT value FROM main.admin WHERE key = 'version'")
    .get()?.value;
  if (version === undefined || !Number.isSafeInteger(version) || version <= 0)
    throw new DotfilesError(`${db.filename}: invalid TCC schema version`);
  const catalog = db
    .query<Baseline["catalog"][number], []>(
      "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name",
    )
    .all();
  return { version, catalog };
}

export function createBaseline(forWrite: boolean): Baseline {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new DotfilesError(
      "Native TCC schema initialization requires Apple Silicon macOS",
    );
  const { image, ddl } = makeInitializerBundle();
  const root = mkdtempSync("/private/tmp/dotfiles-tcc-schema.");
  try {
    const output = join(root, "out");
    mkdirSync(output, { mode: scratchDirectoryMode });
    const path = join(output, "TCC.db");
    const bundle = join(root, "tccd.bundle");
    writeFileSync(bundle, image, { mode: bundleFileMode });
    runWorker(root, [
      "/usr/bin/codesign",
      "--sign",
      "-",
      "--force",
      "--identifier",
      "local.dotfiles.tcc-schema",
      bundle,
    ]);
    const profile = `(version 1)
(deny default)
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "${root}"))
(allow file-write* (subpath "${output}"))
(allow sysctl-read)`;
    const args: Parameters<typeof initializeDatabase> = [profile, bundle, path, ddl];
    runWorker(root, [
      process.execPath,
      "--eval",
      `await (${initializeDatabase.toString()})(...process.argv.slice(1));`,
      ...args,
    ]);
    using db = new Database(path, { readonly: true, create: false });
    const integrity = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (
      integrity?.integrity_check !== "ok" ||
      db.query("SELECT 1 FROM main.access LIMIT 1").get()
    )
      throw new DotfilesError(
        "Native TCC initializer did not produce a valid empty access table",
      );
    if (forWrite) validateWrites(db);
    return readCatalog(db);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Ignore whitespace between SQL tokens, not inside literals or quoted names
function normalize(sql: string | null) {
  return (
    sql
      ?.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\w+|[^\s]/g)
      ?.join("\0") ?? null
  );
}

export function compareSchema(db: Database, baseline: Baseline) {
  const actual = readCatalog(db);
  if (actual.version < baseline.version)
    throw new DotfilesError(
      `${db.filename}: TCC schema ${actual.version} needs migration to ${baseline.version} by macOS`,
    );
  if (actual.version > baseline.version)
    throw new DotfilesError(
      `${db.filename}: TCC schema ${actual.version} is newer than the installed tccd baseline ${baseline.version}`,
    );
  const live = new Map(actual.catalog.map((object) => [object.name, object]));
  for (const expected of baseline.catalog) {
    const object = live.get(expected.name);
    if (
      !object ||
      object.type !== expected.type ||
      object.tbl_name !== expected.tbl_name ||
      normalize(object.sql) !== normalize(expected.sql)
    )
      throw new DotfilesError(
        `${db.filename}: ${expected.type} ${expected.name} differs from the fresh TCC schema`,
      );
    live.delete(expected.name);
  }
  // This is a bootstrap comparison, not a full model of daemon startup DDL
  // Assume additive objects are compatible unless a trigger can intercept access writes
  for (const { type, tbl_name, name } of live.values()) {
    if (type === "trigger" && tbl_name.toLowerCase() === "access")
      throw new DotfilesError(`${db.filename}: unexpected access trigger ${name}`);
  }
}
