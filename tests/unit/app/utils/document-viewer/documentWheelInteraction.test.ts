import {
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
} from 'vitest';
import { ZOOM } from '@app/constants/pdfLayout';
import {
    consumeDocumentWheelZoomInteraction,
    resolveDocumentWheelInteraction,
    resolveDocumentWheelIntent,
    resolveDocumentWheelZoomTarget,
    type IDocumentWheelInteraction,
} from '@app/utils/document-viewer/input/documentWheelInteraction';

function createWheelEvent(overrides: Partial<WheelEvent> = {}) {
    const preventDefault = vi.fn();
    return {
        ctrlKey: false,
        deltaMode: 0,
        deltaY: 120,
        deltaZ: 0,
        metaKey: false,
        preventDefault,
        ...overrides,
    } as WheelEvent;
}

const viewport = {clientHeight: 800} as HTMLElement;

describe('document wheel interaction policy', () => {
    it('keeps physical modifier and depth-axis signals behind the shared resolver', () => {
        type TSourceEvent = IDocumentWheelInteraction['event'];
        expectTypeOf<'ctrlKey' extends keyof TSourceEvent ? true : false>().toEqualTypeOf<false>();
        expectTypeOf<'metaKey' extends keyof TSourceEvent ? true : false>().toEqualTypeOf<false>();
        expectTypeOf<'deltaZ' extends keyof TSourceEvent ? true : false>().toEqualTypeOf<false>();
    });

    it.each([
        {
            expected: 'scroll',
            event: createWheelEvent(),
            isMac: true,
            label: 'plain macOS wheel',
        },
        {
            expected: 'platform-scroll',
            event: createWheelEvent({ctrlKey: true}),
            isMac: true,
            label: 'macOS Control-wheel',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({metaKey: true}),
            isMac: true,
            label: 'macOS Command-wheel',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({ctrlKey: true}),
            isMac: false,
            label: 'non-Mac Control-wheel',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({
                deltaY: 0,
                deltaZ: 2,
            }),
            isMac: true,
            label: 'unmodified depth-axis gesture',
        },
        {
            expected: 'zoom',
            event: createWheelEvent({
                ctrlKey: true,
                metaKey: true,
            }),
            isMac: true,
            label: 'macOS Command-Control-wheel',
        },
    ])('resolves $label as $expected', ({
        event,
        expected,
        isMac,
    }) => {
        expect(resolveDocumentWheelIntent(event, isMac)).toBe(expected);
    });

    it('normalizes line, page, and depth-axis deltas at the shared viewport boundary', () => {
        expect(resolveDocumentWheelInteraction(
            createWheelEvent({
                deltaMode: 1,
                deltaY: 3,
            }),
            viewport,
            false,
        ).deltaPx).toBe(48);
        expect(resolveDocumentWheelInteraction(
            createWheelEvent({
                deltaMode: 2,
                deltaY: 2,
            }),
            viewport,
            false,
        ).deltaPx).toBe(1_600);
        expect(resolveDocumentWheelInteraction(
            createWheelEvent({
                deltaY: 0,
                deltaZ: -4,
            }),
            viewport,
            false,
        ).deltaPx).toBe(-4);
    });

    it('uses one cumulative scaling and clamping policy for every renderer', () => {
        const first = resolveDocumentWheelZoomTarget(1, 0, -120);
        expect(first.valid).toBe(true);
        if (!first.valid) {
            return;
        }
        const second = resolveDocumentWheelZoomTarget(1, first.cumulativeDelta, -120);
        expect(second.valid).toBe(true);
        if (!second.valid) {
            return;
        }
        expect(second.nextZoom).toBeGreaterThan(first.nextZoom);

        const maximum = resolveDocumentWheelZoomTarget(1, 0, -10_000);
        expect(maximum.valid && maximum.nextZoom).toBe(ZOOM.MAX);

        const belowMinimum = resolveDocumentWheelZoomTarget(ZOOM.MIN / 2, 0, 120);
        expect(belowMinimum).toMatchObject({
            cumulativeDelta: 0,
            reason: 'below-manual-min-zoom-out',
            valid: false,
        });
    });

    it('consumes only zoom interactions and emits a shared custom-zoom transition', () => {
        const emitZoom = vi.fn();
        const emitZoomMode = vi.fn();
        const zoomEvent = createWheelEvent({
            metaKey: true,
            deltaY: -120,
        });
        const zoomInteraction = resolveDocumentWheelInteraction(zoomEvent, viewport, true);

        expect(consumeDocumentWheelZoomInteraction(zoomInteraction, {
            effectiveZoom: 1,
            zoomMode: 'fit-width',
            emitZoom,
            emitZoomMode,
        })).toBe(true);
        expect(zoomEvent.preventDefault).toHaveBeenCalledOnce();
        expect(emitZoomMode).toHaveBeenCalledWith('custom');
        expect(emitZoom).toHaveBeenCalledWith(expect.any(Number));

        const scrollEvent = createWheelEvent({ctrlKey: true});
        const scrollInteraction = resolveDocumentWheelInteraction(scrollEvent, viewport, true);
        expect(consumeDocumentWheelZoomInteraction(scrollInteraction, {
            effectiveZoom: 1,
            zoomMode: 'custom',
            emitZoom,
            emitZoomMode,
        })).toBe(false);
        expect(scrollEvent.preventDefault).not.toHaveBeenCalled();
    });
});
