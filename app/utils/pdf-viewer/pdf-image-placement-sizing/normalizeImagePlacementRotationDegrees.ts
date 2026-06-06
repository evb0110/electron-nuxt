const EPSILON = 0.0001;

export function normalizeImagePlacementRotationDegrees(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }

    let normalized = ((value % 360) + 360) % 360;
    if (normalized > 180) {
        normalized -= 360;
    }
    if (Math.abs(normalized) < EPSILON) {
        return 0;
    }
    return normalized;
}
