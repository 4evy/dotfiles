import type { KWin as KWinApi, Workspace } from "kwin-api";

declare global {
  const KWin: KWinApi;
  const workspace: Workspace;
  const registerShortcut: KWinApi["registerShortcut"];
}
