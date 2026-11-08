import bindings from "@dotfiles/tiling/bindings" with { type: "json" };

const CYCLE_RESET_AFTER_MS = 900;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Size = {
  width: number;
  height: number;
};

export type BindingName = keyof typeof bindings;

type Binding = {
  kde: { title: string; accelerator: string };
  gnome: { summary: string; accelerator: string };
} & (
  | { action: "cycle"; presets: [LayoutPreset, ...LayoutPreset[]] }
  | { action: "maximize"; presets: [] }
);

// Both bundle builds validate this JSON contract with Effect Schema
export const BINDINGS = bindings as Record<BindingName, Binding>;
export const BINDING_NAMES = Object.keys(BINDINGS) as BindingName[];

type CycleState = {
  bindingName: BindingName | null;
  step: number;
  lastUsed: number;
};

type LayoutPresetResolver = (workArea: Rect, current: Rect) => Rect;
type Anchor = "start" | "center" | "end";
type LayoutPresetAnchor = {
  horizontal: Anchor;
  vertical: Anchor;
};

const LAYOUT_PRESETS = {
  maximize: {
    resolve: (workArea) => gridRect(workArea, 0, 0, 1, 1),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "almost-maximize": {
    resolve: (workArea) => basisPointRect(workArea, 500, 500, 9000, 9000),
    anchor: { horizontal: "center", vertical: "center" },
  },
  center: {
    resolve: centerCurrentWindow,
    anchor: { horizontal: "center", vertical: "center" },
  },
  "left-half": {
    resolve: (workArea) => gridRect(workArea, 0, 0, 2, 1),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "right-half": {
    resolve: (workArea) => gridRect(workArea, 1, 0, 2, 1),
    anchor: { horizontal: "end", vertical: "start" },
  },
  "top-half": {
    resolve: (workArea) => gridRect(workArea, 0, 0, 1, 2),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "bottom-half": {
    resolve: (workArea) => gridRect(workArea, 0, 1, 1, 2),
    anchor: { horizontal: "start", vertical: "end" },
  },
  "first-third": {
    resolve: (workArea) => gridRect(workArea, 0, 0, 3, 1),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "last-third": {
    resolve: (workArea) => gridRect(workArea, 2, 0, 3, 1),
    anchor: { horizontal: "end", vertical: "start" },
  },
  "left-two-thirds": {
    resolve: (workArea) => spanRect(workArea, 0, 0, 2, 1, 3, 1),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "right-two-thirds": {
    resolve: (workArea) => spanRect(workArea, 1, 0, 2, 1, 3, 1),
    anchor: { horizontal: "end", vertical: "start" },
  },
  "top-third": {
    resolve: (workArea) => gridRect(workArea, 0, 0, 1, 3),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "bottom-third": {
    resolve: (workArea) => gridRect(workArea, 0, 2, 1, 3),
    anchor: { horizontal: "start", vertical: "end" },
  },
  "top-two-thirds": {
    resolve: (workArea) => spanRect(workArea, 0, 0, 1, 2, 1, 3),
    anchor: { horizontal: "start", vertical: "start" },
  },
  "bottom-two-thirds": {
    resolve: (workArea) => spanRect(workArea, 0, 1, 1, 2, 1, 3),
    anchor: { horizontal: "start", vertical: "end" },
  },
} satisfies Record<
  string,
  { resolve: LayoutPresetResolver; anchor: LayoutPresetAnchor }
>;

export type LayoutPreset = keyof typeof LAYOUT_PRESETS;

export const LAYOUT_PRESET_NAMES = Object.keys(LAYOUT_PRESETS) as LayoutPreset[];

export function createCycleState(): CycleState {
  return {
    bindingName: null,
    step: 0,
    lastUsed: 0,
  };
}

export function advanceCycle(
  cycle: CycleState,
  bindingName: BindingName,
  length: number,
  now: number,
) {
  if (
    cycle.bindingName === bindingName &&
    now - cycle.lastUsed <= CYCLE_RESET_AFTER_MS
  ) {
    cycle.step = (cycle.step + 1) % length;
    cycle.lastUsed = now;
    return cycle.step;
  }

  cycle.bindingName = bindingName;
  cycle.step = 0;
  cycle.lastUsed = now;
  return cycle.step;
}

export function resolveLayoutPresetRect(
  workArea: Rect,
  current: Rect,
  preset: LayoutPreset,
): Rect {
  return LAYOUT_PRESETS[preset].resolve(workArea, current);
}

export function fitLayoutPresetRectToMinimumSize(
  workArea: Rect,
  rect: Rect,
  preset: LayoutPreset,
  minimum: Size,
): Rect {
  const width = Math.min(Math.max(rect.width, minimum.width), workArea.width);
  const height = Math.min(Math.max(rect.height, minimum.height), workArea.height);
  const { anchor } = LAYOUT_PRESETS[preset];

  return roundedWithin(workArea, {
    x: anchoredPosition(rect.x, rect.width, width, anchor.horizontal),
    y: anchoredPosition(rect.y, rect.height, height, anchor.vertical),
    width,
    height,
  });
}

function anchoredPosition(
  rectStart: number,
  rectSize: number,
  nextSize: number,
  anchor: Anchor,
) {
  switch (anchor) {
    case "center":
      return rectStart + (rectSize - nextSize) / 2;
    case "end":
      return rectStart + rectSize - nextSize;
    default:
      return rectStart;
  }
}

function roundedWithin(workArea: Rect, rect: Rect): Rect {
  const width = Math.min(Math.max(Math.round(rect.width), 1), workArea.width);
  const height = Math.min(Math.max(Math.round(rect.height), 1), workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  return {
    x: Math.min(Math.max(Math.round(rect.x), workArea.x), maxX),
    y: Math.min(Math.max(Math.round(rect.y), workArea.y), maxY),
    width,
    height,
  };
}

function centerCurrentWindow(workArea: Rect, current: Rect): Rect {
  const width = Math.min(current.width, workArea.width);
  const height = Math.min(current.height, workArea.height);

  return roundedWithin(workArea, {
    x: workArea.x + (workArea.width - width) / 2,
    y: workArea.y + (workArea.height - height) / 2,
    width,
    height,
  });
}

function basisPointRect(
  workArea: Rect,
  x: number,
  y: number,
  width: number,
  height: number,
): Rect {
  const basisPoints = 10_000;

  return roundedWithin(workArea, {
    x: workArea.x + (workArea.width * x) / basisPoints,
    y: workArea.y + (workArea.height * y) / basisPoints,
    width: (workArea.width * width) / basisPoints,
    height: (workArea.height * height) / basisPoints,
  });
}

function gridRect(
  workArea: Rect,
  column: number,
  row: number,
  columns: number,
  rows: number,
): Rect {
  return spanRect(workArea, column, row, 1, 1, columns, rows);
}

function spanRect(
  workArea: Rect,
  column: number,
  row: number,
  columnSpan: number,
  rowSpan: number,
  columns: number,
  rows: number,
): Rect {
  return roundedWithin(workArea, {
    x: workArea.x + (workArea.width * column) / columns,
    y: workArea.y + (workArea.height * row) / rows,
    width: (workArea.width * columnSpan) / columns,
    height: (workArea.height * rowSpan) / rows,
  });
}
