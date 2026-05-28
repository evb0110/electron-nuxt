export function resolveCustomReloadZoomMultiplier(state: {
    currentZoom: number;
    currentEffectiveScale: number;
    targetDisplayZoom: number;
}) {
    const {
        currentZoom,
        currentEffectiveScale,
        targetDisplayZoom,
    } = state;

    if (!Number.isFinite(targetDisplayZoom) || targetDisplayZoom <= 0) {
        return null;
    }

    if (!Number.isFinite(currentZoom) || Math.abs(currentZoom) < 0.0001) {
        return targetDisplayZoom;
    }

    const baselineScale = currentEffectiveScale / currentZoom;
    if (!Number.isFinite(baselineScale) || baselineScale <= 0) {
        return targetDisplayZoom;
    }

    const nextZoom = targetDisplayZoom / baselineScale;
    if (!Number.isFinite(nextZoom) || nextZoom <= 0) {
        return null;
    }

    return nextZoom;
}
