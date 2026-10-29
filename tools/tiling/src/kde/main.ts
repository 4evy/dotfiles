import { registerTilingShortcuts } from "./shortcuts.js";
import { createTilingController } from "./tiling.js";

// Keep this adapter native: QJSEngine lacks the BigInt required by Effect core
// Confirmed on Qt 6.12. Shared geometry and binding data stay platform-independent
registerTilingShortcuts(createTilingController());
