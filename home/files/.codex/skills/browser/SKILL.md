---
description: Control ChatGPT's in-app browser through unified Computer Use for
  navigation, page inspection, clicks, typing, screenshots, and local web
  testing. Use a connector or direct request when the task only needs structured
  information.
metadata:
  short-description: Control the in-app browser with unified Computer Use
name: browser
---

# Browser

Use the app-managed `cua_repl` tool for browser interaction. Follow the browser
named by the user. Browser means ChatGPT's in-app browser unless the user names
another browser.

Follow `cua_repl`'s first-call instructions and read its returned documentation
before continuing. Select an existing tab when the request identifies one. To
open a URL in the in-app browser, the entry point is:

``` javascript
let tab = await cua.createBrowserTab("iab", url, { visible: true });
```

Make that entry call by itself on the first invocation. Use only the APIs in the
tool description and returned documentation. Inspect the updated page after
actions before choosing the next interaction.

If `cua_repl` is deferred, discover it among the available tools before
reporting that browser control is unavailable. The app may remove the old
bundled Browser skill when unified Computer Use is enabled. This personal skill
uses the unified tool directly.
