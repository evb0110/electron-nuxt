import type { TWheelDirection } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

const SAME_DIRECTION_FLIP_COOLDOWN_MS = 180;

function isInSameDirectionFlipCooldown(
    eventTimeMs: number,
    direction: TWheelDirection,
    lastFlipAtMs: number,
    lastFlipDirection: TWheelDirection | 0,
    hasInteriorScrollSinceLastFlip: boolean,
) {
    const sinceLastFlipMs = eventTimeMs - lastFlipAtMs;
    return (
        lastFlipAtMs > 0
        && lastFlipDirection === direction
        && !hasInteriorScrollSinceLastFlip
        && sinceLastFlipMs >= 0
        && sinceLastFlipMs < SAME_DIRECTION_FLIP_COOLDOWN_MS
    );
}

export function createWheelFlipGate() {
    let lastWheelFlipAtMs = 0;
    let lastWheelFlipDirection: TWheelDirection | 0 = 0;
    let interiorScrollSinceLastFlip = false;

    function shouldBlockFlip(direction: TWheelDirection, nowMs: number) {
        return isInSameDirectionFlipCooldown(
            nowMs,
            direction,
            lastWheelFlipAtMs,
            lastWheelFlipDirection,
            interiorScrollSinceLastFlip,
        );
    }

    function recordFlip(direction: TWheelDirection, nowMs: number) {
        lastWheelFlipAtMs = nowMs;
        lastWheelFlipDirection = direction;
        interiorScrollSinceLastFlip = false;
    }

    function recordInteriorScroll() {
        interiorScrollSinceLastFlip = true;
    }

    function reset() {
        lastWheelFlipAtMs = 0;
        lastWheelFlipDirection = 0;
        interiorScrollSinceLastFlip = false;
    }

    return {
        shouldBlockFlip,
        recordFlip,
        recordInteriorScroll,
        reset,
    };
}
