export function getShortestImagePlacementAngleDelta(deltaDegrees: number) {
    let normalized = ((deltaDegrees + 180) % 360 + 360) % 360 - 180;
    if (normalized === -180 && deltaDegrees > 0) {
        normalized = 180;
    }
    return normalized;
}
