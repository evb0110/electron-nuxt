/**
 * A restored display zoom is already the custom zoom multiplier the viewer
 * should re-emit; the reload path only has to reject unusable targets.
 */
export function resolveCustomReloadZoomMultiplier(targetDisplayZoom: number) {
    if (!Number.isFinite(targetDisplayZoom) || targetDisplayZoom <= 0) {
        return null;
    }

    return targetDisplayZoom;
}
