

export function computeVisibleRange(
    visibleStart: number,
    visibleEnd: number,
    numPages: number,
    buffer: number,
) {
    return {
        renderStart: Math.max(1, visibleStart - buffer),
        renderEnd: Math.min(numPages, visibleEnd + buffer),
    };
}
