export function resolveCustomReloadZoomMultiplier(state: {
    currentZoom: number;
    currentEffectiveScale: number;
    targetDisplayZoom: number;
}) {
    const { targetDisplayZoom } = state;

    if (!Number.isFinite(targetDisplayZoom) || targetDisplayZoom <= 0) {
        return null;
    }

    return targetDisplayZoom;
}
