// Runs in a separate Bun process. Keep this function self-contained for --eval
export async function initializeDatabase(
  profile: string,
  bundle: string,
  path: string,
  ddl: string,
) {
  const libobjc = "/usr/lib/libobjc.A.dylib";
  const rtldNow = 0x2;
  const rtldLocal = 0x4;
  const loadFlags = rtldNow | rtldLocal;
  const inlineSandboxProfile = 0n;
  const sandboxDenied = 1;
  // Private sandbox_check filter values, checked by the denial probes below
  const pathFilter = 1;
  const globalNameFilter = 2;
  const localNameFilter = 3;
  const sqliteOk = 0;

  const { CString, dlopen, linkSymbols } = await import("bun:ffi");
  const c = (text: string) => Buffer.from(`${text}\0`);
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    sandbox_init: { args: ["ptr", "u64", "ptr"], returns: "i32" },
    // Bun FFI uses fixed signatures. Fill the remaining arm64 GP argument
    // registers so sandbox_check sees its first variadic argument on the stack
    sandbox_check: {
      args: ["i32", "ptr", "i32", "u64", "u64", "u64", "u64", "u64", "ptr"],
      returns: "i32",
    },
    dlopen: { args: ["ptr", "i32"], returns: "ptr" },
    dlerror: { args: [], returns: "ptr" },
    dlsym: { args: ["ptr", "ptr"], returns: "ptr" },
  }).symbols;
  const objc = dlopen(libobjc, {
    objc_lookUpClass: { args: ["ptr"], returns: "ptr" },
    sel_registerName: { args: ["ptr"], returns: "ptr" },
    class_getInstanceMethod: { args: ["ptr", "ptr"], returns: "ptr" },
    method_getTypeEncoding: { args: ["ptr"], returns: "ptr" },
    objc_msgSend: { args: ["ptr", "ptr"], returns: "ptr" },
  }).symbols;
  const objcHandle = system.dlopen(c(libobjc), loadFlags);
  const msgSend = objcHandle && system.dlsym(objcHandle, c("objc_msgSend"));
  if (!msgSend) throw new Error("Objective-C dispatch unavailable");
  const send = linkSymbols({
    string: { ptr: msgSend, args: ["ptr", "ptr", "ptr"], returns: "ptr" },
    construct: { ptr: msgSend, args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
    create: { ptr: msgSend, args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    commit: { ptr: msgSend, args: ["ptr", "ptr"], returns: "i32" },
    dispose: { ptr: msgSend, args: ["ptr", "ptr"], returns: "void" },
  }).symbols;

  const enterSandbox = () => {
    if (system.sandbox_init(c(profile), inlineSandboxProfile, null) !== 0)
      throw new Error("Could not sandbox the TCC schema worker");
    const requireDenied = (name: string, filter: number, operations: string[]) => {
      if (
        operations.some(
          (operation) =>
            system.sandbox_check(
              process.pid,
              c(operation),
              filter,
              0n,
              0n,
              0n,
              0n,
              0n,
              c(name),
            ) !== sandboxDenied,
        )
      )
        throw new Error(`Sandbox did not deny access to ${name}`);
    };
    const machOperations = ["mach-lookup", "mach-register"];
    for (const name of ["com.apple.tccd", "com.apple.tccd.system"]) {
      requireDenied(name, globalNameFilter, machOperations);
      requireDenied(name, localNameFilter, machOperations);
    }
    const fileOperations = ["file-read-data", "file-write-data"];
    for (const name of [
      "/Library/Application Support/com.apple.TCC/TCC.db",
      "/private/var/containers/Data/ProtectedSystem",
    ])
      requireDenied(name, pathFilter, fileOperations);
  };
  enterSandbox();

  for (const image of [
    "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation",
    bundle,
  ]) {
    if (system.dlopen(c(image), loadFlags)) continue;
    const detail = system.dlerror();
    throw new Error(
      `Could not load ${image}: ${detail ? new CString(detail) : "unknown error"}`,
    );
  }
  const sel = (name: string) => objc.sel_registerName(c(name));
  const main = objc.objc_lookUpClass(c("TCCDMainDatabase"));
  const sqlite = objc.objc_lookUpClass(c("TCCDSQLDatabase"));
  const string = objc.objc_lookUpClass(c("NSString"));
  const pool = objc.objc_lookUpClass(c("NSAutoreleasePool"));
  if (!main || !sqlite || !string || !pool)
    throw new Error("TCC schema classes unavailable");
  type ClassHandle = NonNullable<ReturnType<typeof objc.objc_lookUpClass>>;
  const checkedSelector = (
    name: string,
    expected: string,
    forwardingClass?: ClassHandle,
  ) => {
    const selector = sel(name);
    const matchesEncoding = (cls: ClassHandle) => {
      const method = objc.class_getInstanceMethod(cls, selector);
      const encoding = method && objc.method_getTypeEncoding(method);
      return !!encoding && new CString(encoding).toString() === expected;
    };
    if (
      !matchesEncoding(main) ||
      (forwardingClass && !matchesEncoding(forwardingClass))
    )
      throw new Error(`Unsupported TCC schema method: ${name}`);
    return selector;
  };
  // The constructor passes path and SQL as objects to the backing SQL database
  // Main's create and commit forward to it, where both paths use sqlite3_exec
  const construct = checkedSelector(
    "initWithDatabasePath:initialSQL:",
    "@32@0:8@16@24",
  );
  const create = checkedSelector(
    "_createDatabase:initialSetup:",
    "i32@0:8@16@24",
    sqlite,
  );
  const commit = checkedSelector("commit", "i16@0:8", sqlite);
  const close = checkedSelector("closeDatabase", "v16@0:8", sqlite);

  const scope = objc.objc_msgSend(objc.objc_msgSend(pool, sel("alloc")), sel("init"));
  const ns = (text: string) =>
    send.string(string, sel("stringWithUTF8String:"), c(text));
  try {
    const destination = ns(path);
    const bootstrap = ns(ddl);
    if (!destination || !bootstrap)
      throw new Error("Could not marshal the TCC initializer inputs");
    const db = send.construct(
      objc.objc_msgSend(main, sel("alloc")),
      construct,
      destination,
      bootstrap,
    );
    if (!db) throw new Error("Could not initialize the TCC database object");
    try {
      // The native create method opens a transaction and executes the bootstrap
      // SQL. Commit it explicitly before closing the database
      const status = send.create(db, create, destination, bootstrap);
      if (status !== sqliteOk)
        throw new Error(`tccd database creation failed (${status})`);
      const committed = send.commit(db, commit);
      if (committed !== sqliteOk)
        throw new Error(`tccd database commit failed (${committed})`);
    } finally {
      send.dispose(db, close);
      send.dispose(db, sel("release"));
    }
  } finally {
    send.dispose(scope, sel("drain"));
  }
}
