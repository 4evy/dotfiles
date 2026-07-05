import type Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import type { LayoutPreset } from '../shared/lib.js';
import {
    fitLayoutPresetRectToMinimumSize,
    resolveLayoutPresetRect,
} from '../shared/lib.js';

export function resolveLayout(window: Meta.Window, preset: LayoutPreset) {
    const workArea = window.get_work_area_current_monitor();
    let rect = resolveLayoutPresetRect(
        workArea,
        window.get_frame_rect(),
        preset,
    );
    const [hasMinSize, minWidth, minHeight] = window.get_min_size();
    if (hasMinSize) {
        rect = fitLayoutPresetRectToMinimumSize(workArea, rect, preset, {
            width: minWidth,
            height: minHeight,
        });
    }

    return Mtk.Rectangle.new(rect.x, rect.y, rect.width, rect.height);
}
