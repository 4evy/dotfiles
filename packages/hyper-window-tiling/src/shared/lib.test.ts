import { afterEach, describe, expect, test } from 'bun:test';
import type { LayoutPreset, Rect } from './lib.js';
import {
    advanceCycle,
    CYCLE_BINDING_NAMES,
    CYCLE_LAYOUT_PRESETS,
    createCycleState,
    fitLayoutPresetRectToMinimumSize,
    resolveLayoutPresetRect,
} from './lib.js';

const ALL_PRESETS = [
    ...new Set(Object.values(CYCLE_LAYOUT_PRESETS).flat()),
] as LayoutPreset[];

const REAL_DATE_NOW = Date.now;

afterEach(() => {
    Date.now = REAL_DATE_NOW;
});

function setNow(value: number) {
    Date.now = () => value;
}

function expectRect(actual: Rect, expected: Rect) {
    expect(actual).toEqual(expected);
}

describe('advanceCycle', () => {
    test('cycles repeated binding presses within 900 ms and wraps', () => {
        const cycle = createCycleState();

        setNow(1_000);
        expect(advanceCycle(cycle, 'move-left', 3)).toBe(0);

        setNow(1_900);
        expect(advanceCycle(cycle, 'move-left', 3)).toBe(1);

        setNow(2_000);
        expect(advanceCycle(cycle, 'move-left', 3)).toBe(2);

        setNow(2_100);
        expect(advanceCycle(cycle, 'move-left', 3)).toBe(0);
    });

    test('resets after 900 ms and when the binding changes', () => {
        const cycle = createCycleState();

        setNow(1_000);
        expect(advanceCycle(cycle, 'move-up', 3)).toBe(0);

        setNow(1_901);
        expect(advanceCycle(cycle, 'move-up', 3)).toBe(0);

        setNow(2_000);
        expect(advanceCycle(cycle, 'move-up', 3)).toBe(1);

        setNow(2_100);
        expect(advanceCycle(cycle, 'move-right', 3)).toBe(0);
    });

    test('uses independent cycle lengths for shorter bindings', () => {
        const cycle = createCycleState();

        setNow(1_000);
        expect(advanceCycle(cycle, 'move-max-almost', 2)).toBe(0);

        setNow(1_100);
        expect(advanceCycle(cycle, 'move-max-almost', 2)).toBe(1);

        setNow(1_200);
        expect(advanceCycle(cycle, 'move-max-almost', 2)).toBe(0);
    });
});

describe('resolveLayoutPresetRect', () => {
    test('matches Kanata preset geometry for the configured aliases', () => {
        const workArea = { x: 100, y: 50, width: 1200, height: 900 };
        const current = { x: 200, y: 100, width: 640, height: 480 };

        expectRect(resolveLayoutPresetRect(workArea, current, 'top-half'), {
            x: 100,
            y: 50,
            width: 1200,
            height: 450,
        });
        expectRect(
            resolveLayoutPresetRect(workArea, current, 'top-two-thirds'),
            { x: 100, y: 50, width: 1200, height: 600 },
        );
        expectRect(resolveLayoutPresetRect(workArea, current, 'top-third'), {
            x: 100,
            y: 50,
            width: 1200,
            height: 300,
        });
        expectRect(resolveLayoutPresetRect(workArea, current, 'left-half'), {
            x: 100,
            y: 50,
            width: 600,
            height: 900,
        });
        expectRect(
            resolveLayoutPresetRect(workArea, current, 'left-two-thirds'),
            { x: 100, y: 50, width: 800, height: 900 },
        );
        expectRect(resolveLayoutPresetRect(workArea, current, 'first-third'), {
            x: 100,
            y: 50,
            width: 400,
            height: 900,
        });
        expectRect(resolveLayoutPresetRect(workArea, current, 'bottom-half'), {
            x: 100,
            y: 500,
            width: 1200,
            height: 450,
        });
        expectRect(
            resolveLayoutPresetRect(workArea, current, 'bottom-two-thirds'),
            { x: 100, y: 350, width: 1200, height: 600 },
        );
        expectRect(resolveLayoutPresetRect(workArea, current, 'bottom-third'), {
            x: 100,
            y: 650,
            width: 1200,
            height: 300,
        });
        expectRect(resolveLayoutPresetRect(workArea, current, 'right-half'), {
            x: 700,
            y: 50,
            width: 600,
            height: 900,
        });
        expectRect(
            resolveLayoutPresetRect(workArea, current, 'right-two-thirds'),
            { x: 500, y: 50, width: 800, height: 900 },
        );
        expectRect(resolveLayoutPresetRect(workArea, current, 'last-third'), {
            x: 900,
            y: 50,
            width: 400,
            height: 900,
        });
        expectRect(
            resolveLayoutPresetRect(workArea, current, 'almost-maximize'),
            { x: 160, y: 95, width: 1080, height: 810 },
        );
        expectRect(resolveLayoutPresetRect(workArea, current, 'center'), {
            x: 380,
            y: 260,
            width: 640,
            height: 480,
        });
        expectRect(resolveLayoutPresetRect(workArea, current, 'maximize'), {
            x: 100,
            y: 50,
            width: 1200,
            height: 900,
        });
    });

    test('centers oversized current windows by first clamping to the work area', () => {
        const workArea = { x: -1920, y: 24, width: 1600, height: 876 };
        const current = { x: -2100, y: -100, width: 2000, height: 1200 };

        expectRect(resolveLayoutPresetRect(workArea, current, 'center'), {
            x: -1920,
            y: 24,
            width: 1600,
            height: 876,
        });
    });

    test('rounds odd-sized work areas without producing invalid rectangles', () => {
        const workArea = { x: -1279, y: 31, width: 1279, height: 719 };
        const current = { x: -1000, y: 100, width: 333, height: 222 };

        expectRect(
            resolveLayoutPresetRect(workArea, current, 'right-two-thirds'),
            { x: -853, y: 31, width: 853, height: 719 },
        );
        expectRect(resolveLayoutPresetRect(workArea, current, 'bottom-third'), {
            x: -1279,
            y: 510,
            width: 1279,
            height: 240,
        });
        expectRect(
            resolveLayoutPresetRect(workArea, current, 'almost-maximize'),
            { x: -1215, y: 67, width: 1151, height: 647 },
        );
    });

    test('all configured cycle layouts resolve to finite positive rectangles inside the work area', () => {
        const scenarios = [
            {
                workArea: { x: 0, y: 0, width: 1, height: 1 },
                current: { x: 0, y: 0, width: 10, height: 10 },
            },
            {
                workArea: { x: -2560, y: 48, width: 2560, height: 1392 },
                current: { x: -2200, y: 100, width: 900, height: 700 },
            },
            {
                workArea: { x: 17, y: -900, width: 3441, height: 1441 },
                current: { x: 500, y: -500, width: 5120, height: 2160 },
            },
        ];

        for (const { workArea, current } of scenarios) {
            for (const preset of ALL_PRESETS) {
                const rect = resolveLayoutPresetRect(workArea, current, preset);

                expect(Number.isFinite(rect.x)).toBeTrue();
                expect(Number.isFinite(rect.y)).toBeTrue();
                expect(Number.isFinite(rect.width)).toBeTrue();
                expect(Number.isFinite(rect.height)).toBeTrue();
                expect(rect.width).toBeGreaterThan(0);
                expect(rect.height).toBeGreaterThan(0);
                expect(rect.x).toBeGreaterThanOrEqual(workArea.x);
                expect(rect.y).toBeGreaterThanOrEqual(workArea.y);
                expect(rect.x + rect.width).toBeLessThanOrEqual(
                    workArea.x + workArea.width,
                );
                expect(rect.y + rect.height).toBeLessThanOrEqual(
                    workArea.y + workArea.height,
                );
            }
        }
    });

    test('every configured binding references a non-empty known preset cycle', () => {
        expect(CYCLE_BINDING_NAMES).toEqual([
            'move-up',
            'move-left',
            'move-down',
            'move-right',
            'move-max-almost',
        ]);

        for (const bindingName of CYCLE_BINDING_NAMES) {
            expect(CYCLE_LAYOUT_PRESETS[bindingName].length).toBeGreaterThan(0);
            for (const preset of CYCLE_LAYOUT_PRESETS[bindingName]) {
                expect(ALL_PRESETS).toContain(preset);
            }
        }
    });

    test('keeps right layouts attached to the right edge when minimum width is larger than the preset', () => {
        const workArea = { x: 0, y: 0, width: 1280, height: 720 };
        const rect = resolveLayoutPresetRect(workArea, workArea, 'last-third');

        expectRect(
            fitLayoutPresetRectToMinimumSize(workArea, rect, 'last-third', {
                width: 760,
                height: 1,
            }),
            { x: 520, y: 0, width: 760, height: 720 },
        );
    });

    test('keeps bottom layouts attached to the bottom edge when minimum height is larger than the preset', () => {
        const workArea = { x: 0, y: 0, width: 1280, height: 720 };
        const rect = resolveLayoutPresetRect(
            workArea,
            workArea,
            'bottom-third',
        );

        expectRect(
            fitLayoutPresetRectToMinimumSize(workArea, rect, 'bottom-third', {
                width: 1,
                height: 360,
            }),
            { x: 0, y: 360, width: 1280, height: 360 },
        );
    });
});
