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

        expect(gate.shouldBlockFlip(-1, 40)).toBe(false);
    });

    it('allows the next edge flip after interior page scrolling', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.recordInteriorScroll();

        expect(gate.shouldBlockFlip(1, 40)).toBe(false);
    });

    it('clears cooldown state on reset', () => {
        const gate = createWheelFlipGate();

        gate.recordFlip(1, 10);
        gate.reset();

        expect(gate.shouldBlockFlip(1, 40)).toBe(false);
    });
});
