import {
    describe,
    expect,
    it,
} from 'vitest';
import { createWheelFlipGate } from '@app/modules/pdf-viewer/runtime/navigation/createWheelFlipGate';

describe('createWheelFlipGate', () => {
    it('blocks same-direction flips inside the cooldown window', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);

        expect(gate.shouldBlockFlip(1, 40)).toBe(true);
        expect(gate.shouldBlockFlip(1, 190)).toBe(false);
    });

    it('allows immediate flips after direction changes', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.recordWheelPacket(20);

        expect(gate.shouldBlockFlip(-1, 40)).toBe(false);
    });

    it('blocks same-direction flips in the same pixel-wheel gesture when requested', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.recordWheelPacket(160);

        expect(gate.shouldBlockFlip(1, 260)).toBe(false);
        expect(gate.shouldBlockFlip(1, 260, { requireGestureIdle: true })).toBe(true);

        gate.recordWheelPacket(260);
        expect(gate.shouldBlockFlip(1, 470, { requireGestureIdle: true })).toBe(false);
    });

    it('allows the next edge flip after interior page scrolling', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.recordWheelPacket(40);
        gate.recordInteriorScroll();

        expect(gate.shouldBlockFlip(1, 260, { requireGestureIdle: true })).toBe(false);
    });

    it('clears cooldown state on reset', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.reset();

        expect(gate.shouldBlockFlip(1, 40)).toBe(false);
    });
});
