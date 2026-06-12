export function summarizeViewerMetrics(container: HTMLElement | null) {
    if (!container) {
        return null;
    }
    return {
        scrollTop: Math.round(container.scrollTop),
        scrollLeft: Math.round(container.scrollLeft),
        clientWidth: Math.round(container.clientWidth),
        clientHeight: Math.round(container.clientHeight),
        scrollWidth: Math.round(container.scrollWidth),
        scrollHeight: Math.round(container.scrollHeight),
    };
}
