import type { TWheelDirection } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

const SAME_DIRECTION_FLIP_COOLDOWN_MS = 180;
const SAME_DIRECTION_GESTURE_IDLE_MS = 200;

interface IShouldBlockFlipOptions { requireGestureIdle?: boolean; }

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

function isInSameDirectionGesture(
    eventTimeMs: number,
    direction: TWheelDirection,
    lastFlipAtMs: number,
    lastFlipDirection: TWheelDirection | 0,
    lastWheelPacketAtMs: number,
    hasInteriorScrollSinceLastFlip: boolean,
) {
    const sinceLastWheelPacketMs = eventTimeMs - lastWheelPacketAtMs;
    return (
        lastFlipAtMs > 0
        && lastWheelPacketAtMs > 0
        && lastFlipDirection === direction
        && !hasInteriorScrollSinceLastFlip
        && sinceLastWheelPacketMs >= 0
        && sinceLastWheelPacketMs < SAME_DIRECTION_GESTURE_IDLE_MS
    );
}

export function createWheelFlipGate() {
    let lastWheelFlipAtMs = 0;
    let lastWheelFlipDirection: TWheelDirection | 0 = 0;
    let lastWheelPacketAtMs = 0;
    let interiorScrollSinceLastFlip = false;

    function shouldBlockFlip(
        direction: TWheelDirection,
        nowMs: number,
        options?: IShouldBlockFlipOptions,
    ) {
        if (isInSameDirectionFlipCooldown(
            nowMs,
            direction,
            lastWheelFlipAtMs,
            lastWheelFlipDirection,
            interiorScrollSinceLastFlip,
        )) {
            return true;
        }

        return options?.requireGestureIdle === true
            && isInSameDirectionGesture(
                nowMs,
                direction,
                lastWheelFlipAtMs,
                lastWheelFlipDirection,
                lastWheelPacketAtMs,
                interiorScrollSinceLastFlip,
            );
    }

    function recordFlip(direction: TWheelDirection, nowMs: number) {
        lastWheelFlipAtMs = nowMs;
        lastWheelFlipDirection = direction;
        lastWheelPacketAtMs = nowMs;
        interiorScrollSinceLastFlip = false;
    }

    function recordWheelPacket(nowMs: number) {
        lastWheelPacketAtMs = nowMs;
    }

    function recordInteriorScroll() {
        interiorScrollSinceLastFlip = true;
    }

    function reset() {
        lastWheelFlipAtMs = 0;
        lastWheelFlipDirection = 0;
        lastWheelPacketAtMs = 0;
        interiorScrollSinceLastFlip = false;
    }

    return {
        shouldBlockFlip,
        recordFlip,
        recordWheelPacket,
        recordInteriorScroll,
        reset,
    };
}
