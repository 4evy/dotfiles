// TCC's on-disk identity encoding and sentinel for unscoped grants
export const tccClientTypes = { bundleIdentifier: 0, absolutePath: 1 } as const;
export const tccNoTargetType = 0;
export const tccNoTarget = "UNUSED";
export const tccAnyTarget = "any";
export const tccServicePrefix = "kTCCService";
