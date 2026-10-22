---
description: Control local Mac apps through unified Computer Use when the task
  requires reading or operating an app's interface. Prefer a dedicated connector
  or CLI when it can complete the requested operation directly.
metadata:
  short-description: Control Mac apps with unified Computer Use
name: computer
---

# Computer Use

Use the app-managed `cua_repl` tool for native app interaction. Follow its
first-call instructions and read its returned documentation before continuing.
When the user names an app, select it directly:

``` javascript
let app = await cua.getApp(appName);
```

Make that entry call by itself on the first invocation. Request an inventory
with `cua.getState()` when the intended app is unknown. Use only the APIs in the
tool description and returned documentation. Inspect the updated app state after
actions before choosing the next interaction.

If `cua_repl` is deferred, discover it among the available tools before
reporting that computer control is unavailable. The app may remove the old
bundled Computer Use skill when unified Computer Use is enabled. This personal
skill uses the unified tool directly.
