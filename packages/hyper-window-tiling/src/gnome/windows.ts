import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import type Mtk from 'gi://Mtk';

const MOVE_RESIZE_RETRY_DELAY_MS = 75;
const moveResizeSerials = new WeakMap<Meta.Window, number>();

const IGNORED_WINDOW_TYPES = new Set([
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
]);

export function focusedWindow() {
    const window = global.display.focus_window;
    if (!window) return null;

    return [
        window.is_override_redirect(),
        window.is_fullscreen(),
        window.is_skip_taskbar(),
        IGNORED_WINDOW_TYPES.has(window.get_window_type()),
    ].some(Boolean)
        ? null
        : window;
}

export function canMoveResizeWindow(window: Meta.Window) {
    if (window.get_maximize_flags()) {
        return window.can_maximize();
    }

    return window.allows_move() && window.allows_resize();
}

export function moveResizeWindow(window: Meta.Window, rect: Mtk.Rectangle) {
    const serial = nextMoveResizeSerial(window);

    if (window.get_maximize_flags()) {
        window.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
        window.unmaximize();
    }

    moveResizeFrame(window, rect);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOVE_RESIZE_RETRY_DELAY_MS, () => {
        if (window.is_alive && moveResizeSerials.get(window) === serial) {
            moveResizeFrame(window, rect);
        }

        return GLib.SOURCE_REMOVE;
    });
}

function nextMoveResizeSerial(window: Meta.Window) {
    const serial = (moveResizeSerials.get(window) ?? 0) + 1;
    moveResizeSerials.set(window, serial);
    return serial;
}

function moveResizeFrame(window: Meta.Window, rect: Mtk.Rectangle) {
    window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
}
