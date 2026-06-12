const WHEEL_LINE_DELTA_PX = 16;

export function normalizePageWheelDelta(
    delta: number,
    mode: number,
    container: HTMLElement,
) {
    if (mode === 1) {
        return delta * WHEEL_LINE_DELTA_PX;
    }
    if (mode === 2) {
        return delta * container.clientHeight;
    }
    return delta;
}
