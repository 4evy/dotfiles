import { registerTilingShortcuts } from "./shortcuts.js";
import { createTilingController } from "./tiling.js";

registerTilingShortcuts(createTilingController());
