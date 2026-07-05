const CYCLE_RESET_AFTER_MS = 900;

export const MAXIMIZE_BINDING_NAME = 'move-max';

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

export type CycleBindingName =
    | 'move-up'
    | 'move-left'
    | 'move-down'
    | 'move-right'
    | 'move-max-almost';

export type MaximizeBindingName = typeof MAXIMIZE_BINDING_NAME;
export type BindingName = CycleBindingName | MaximizeBindingName;

export type LayoutPreset =
    | 'maximize'
    | 'almost-maximize'
    | 'center'
    | 'left-half'
    | 'right-half'
    | 'top-half'
    | 'bottom-half'
    | 'first-third'
    | 'last-third'
    | 'left-two-thirds'
    | 'right-two-thirds'
    | 'top-third'
    | 'bottom-third'
    | 'top-two-thirds'
    | 'bottom-two-thirds';

type CycleState = {
    bindingName: CycleBindingName | null;
    step: number;
    lastUsed: number;
};

type LayoutPresetResolver = (workArea: Rect, current: Rect) => Rect;
type Anchor = 'start' | 'center' | 'end';
type LayoutPresetAnchor = {
    horizontal: Anchor;
    vertical: Anchor;
};

const LAYOUT_PRESET_RESOLVERS = {
    maximize: (workArea) => gridRect(workArea, 0, 0, 1, 1),
    'almost-maximize': (workArea) =>
        basisPointRect(workArea, 500, 500, 9000, 9000),
    center: centerCurrentWindow,
    'left-half': (workArea) => gridRect(workArea, 0, 0, 2, 1),
    'right-half': (workArea) => gridRect(workArea, 1, 0, 2, 1),
    'top-half': (workArea) => gridRect(workArea, 0, 0, 1, 2),
    'bottom-half': (workArea) => gridRect(workArea, 0, 1, 1, 2),
    'first-third': (workArea) => gridRect(workArea, 0, 0, 3, 1),
    'last-third': (workArea) => gridRect(workArea, 2, 0, 3, 1),
    'left-two-thirds': (workArea) => spanRect(workArea, 0, 0, 2, 1, 3, 1),
    'right-two-thirds': (workArea) => spanRect(workArea, 1, 0, 2, 1, 3, 1),
    'top-third': (workArea) => gridRect(workArea, 0, 0, 1, 3),
    'bottom-third': (workArea) => gridRect(workArea, 0, 2, 1, 3),
    'top-two-thirds': (workArea) => spanRect(workArea, 0, 0, 1, 2, 1, 3),
    'bottom-two-thirds': (workArea) => spanRect(workArea, 0, 1, 1, 2, 1, 3),
} as const satisfies Record<LayoutPreset, LayoutPresetResolver>;

const LAYOUT_PRESET_ANCHORS = {
    maximize: { horizontal: 'start', vertical: 'start' },
    'almost-maximize': { horizontal: 'center', vertical: 'center' },
    center: { horizontal: 'center', vertical: 'center' },
    'left-half': { horizontal: 'start', vertical: 'start' },
    'right-half': { horizontal: 'end', vertical: 'start' },
    'top-half': { horizontal: 'start', vertical: 'start' },
    'bottom-half': { horizontal: 'start', vertical: 'end' },
    'first-third': { horizontal: 'start', vertical: 'start' },
    'last-third': { horizontal: 'end', vertical: 'start' },
    'left-two-thirds': { horizontal: 'start', vertical: 'start' },
    'right-two-thirds': { horizontal: 'end', vertical: 'start' },
    'top-third': { horizontal: 'start', vertical: 'start' },
    'bottom-third': { horizontal: 'start', vertical: 'end' },
    'top-two-thirds': { horizontal: 'start', vertical: 'start' },
    'bottom-two-thirds': { horizontal: 'start', vertical: 'end' },
} as const satisfies Record<LayoutPreset, LayoutPresetAnchor>;

export const CYCLE_LAYOUT_PRESETS = {
    'move-up': ['top-half', 'top-two-thirds', 'top-third'],
    'move-left': ['left-half', 'left-two-thirds', 'first-third'],
    'move-down': ['bottom-half', 'bottom-two-thirds', 'bottom-third'],
    'move-right': ['right-half', 'right-two-thirds', 'last-third'],
    'move-max-almost': ['almost-maximize', 'center'],
} as const satisfies Record<CycleBindingName, readonly LayoutPreset[]>;

export const CYCLE_BINDING_NAMES = Object.keys(
    CYCLE_LAYOUT_PRESETS,
) as CycleBindingName[];

export function createCycleState(): CycleState {
    return {
        bindingName: null,
        step: 0,
        lastUsed: 0,
    };
}

export function advanceCycle(
    cycle: CycleState,
    bindingName: CycleBindingName,
    length: number,
) {
    const now = Date.now();
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
    return LAYOUT_PRESET_RESOLVERS[preset](workArea, current);
}

export function fitLayoutPresetRectToMinimumSize(
    workArea: Rect,
    rect: Rect,
    preset: LayoutPreset,
    minimum: Size,
): Rect {
    const width = Math.min(Math.max(rect.width, minimum.width), workArea.width);
    const height = Math.min(
        Math.max(rect.height, minimum.height),
        workArea.height,
    );
    const anchor = LAYOUT_PRESET_ANCHORS[preset];

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
        case 'center':
            return rectStart + (rectSize - nextSize) / 2;
        case 'end':
            return rectStart + rectSize - nextSize;
        default:
            return rectStart;
    }
}

function roundedWithin(workArea: Rect, rect: Rect): Rect {
    const width = Math.min(Math.max(Math.round(rect.width), 1), workArea.width);
    const height = Math.min(
        Math.max(Math.round(rect.height), 1),
        workArea.height,
    );
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
