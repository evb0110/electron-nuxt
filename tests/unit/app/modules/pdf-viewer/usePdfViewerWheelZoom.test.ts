import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';

const captureScrollSnapshot = vi.fn();
const restoreScrollFromSnapshot = vi.fn();

vi.mock('@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/captureScrollSnapshot', () => ({captureScrollSnapshot: (...args: unknown[]) => captureScrollSnapshot(...args)}));
vi.mock('@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/restoreScrollFromSnapshot', () => ({restoreScrollFromSnapshot: (...args: unknown[]) => restoreScrollFromSnapshot(...args)}));

vi.mock('@app/utils/browserLogger', () => {
    return { BrowserLogger: {
        diagnostic: vi.fn(),
        diagnosticThrottled: vi.fn(),
        warn: vi.fn(),
        warnThrottled: vi.fn(),
    } };
});

const { usePdfViewerWheelZoom } = await import('@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoom');

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

describe('usePdfViewerWheelZoom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
        captureScrollSnapshot.mockReturnValue({
            anchorViewportX: 120,
            anchorViewportY: 160,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function createViewerContainer() {
        return toElement({
            clientWidth: 500,
            clientHeight: 800,
            scrollWidth: 2000,
            scrollHeight: 4000,
            scrollTop: 40,
            scrollLeft: 10,
            getBoundingClientRect: () => ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 500,
                bottom: 800,
                width: 500,
                height: 800,
                toJSON: () => ({}),
            }),
        });
    }

    function createWheelEvent(overrides: Partial<WheelEvent> = {}) {
        const event = {
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            deltaMode: 0,
            deltaX: 0,
            deltaY: 0,
            deltaZ: 0,
            cancelable: true,
            defaultPrevented: false,
            clientX: 0,
            clientY: 0,
            preventDefault() {
                Object.defineProperty(event, 'defaultPrevented', {
                    value: true,
                    configurable: true,
                });
            },
            ...overrides,
        } as WheelEvent;
        return event;
    }

    function setupWheelZoom() {
        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const zoom = ref(1);
        const zoomMode = ref<'fit-width' | 'custom'>('fit-width');
        const effectiveScale = ref(1);
        const zoomVirtualizationFreeze = ref(null);
        const singlePageScroll = {
            suppressSnapFor: vi.fn(),
            handleWheel: vi.fn(() => false),
            handleScroll: vi.fn(),
            cancelProgrammaticNavigation: vi.fn(),
        };
        const cancelPendingSearchScroll = vi.fn();
        const markUserViewportInteraction = vi.fn(() => {
            singlePageScroll.cancelProgrammaticNavigation();
        });
        const emit = vi.fn();

        const scope = effectScope();
        const wheelZoom = scope.run(() => usePdfViewerWheelZoom({
            viewerContainer,
            src: computed(() => ({ kind: 'data' }) as never),
            isLoading: ref(false),
            zoom: computed(() => zoom.value),
            zoomMode: computed(() => zoomMode.value),
            effectiveScale,
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 6,
            }),
            virtualizedContinuousMode: ref(true),
            virtualWindowStart: ref(2),
            virtualWindowEnd: ref(8),
            topVirtualSpacerStyle: ref({ height: '120px' }),
            bottomVirtualSpacerStyle: ref({ height: '240px' }),
            zoomVirtualizationFreeze,
            singlePageScroll,
            cancelPendingSearchScroll,
            markUserViewportInteraction,
            isSnipActive: () => false,
            emit: emit as never,
        }));

        if (!wheelZoom) {
            throw new Error('Failed to create wheel zoom composable');
        }

        return {
            scope,
            zoom,
            effectiveScale,
            viewerContainer,
            zoomVirtualizationFreeze,
            singlePageScroll,
            cancelPendingSearchScroll,
            markUserViewportInteraction,
            emit,
            wheelZoom,
        };
    }

    it('starts a modifier-wheel zoom session and emits custom zoom updates', () => {
        const setup = setupWheelZoom();

        try {
            const event = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });

            setup.wheelZoom.handleViewerWheel(event);

            const emittedEffectiveZoom = setup.emit.mock.calls.find(
                call => call[0] === 'update:effectiveZoom',
            )?.[1];
            const emittedZoom = setup.emit.mock.calls.find(call => call[0] === 'update:zoom')?.[1];

            expect(event.defaultPrevented).toBe(true);
            expect(setup.emit).toHaveBeenCalledWith('update:zoomMode', 'custom');
            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', expect.any(Number));
            expect(setup.emit).toHaveBeenCalledWith('update:zoom', expect.any(Number));
            expect(Number.isFinite(emittedEffectiveZoom)).toBe(true);
            expect(Number.isFinite(emittedZoom)).toBe(true);
            expect(emittedEffectiveZoom).toBeGreaterThan(1);
            expect(emittedZoom).toBeGreaterThan(1);
            expect(setup.zoomVirtualizationFreeze.value).toEqual(expect.objectContaining({
                sessionId: 1,
                windowStart: 2,
                windowEnd: 8,
                topSpacerHeight: 120,
                bottomSpacerHeight: 240,
            }));
        } finally {
            setup.scope.stop();
        }
    });

    it('suppresses non-modifier wheel packets while the zoom interaction is locked', () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.wheelZoom.handleViewerWheel(zoomEvent);

            const plainWheelEvent = createWheelEvent({
                deltaY: 80,
                clientX: 130,
                clientY: 180,
            });
            setup.wheelZoom.handleViewerWheel(plainWheelEvent);

            expect(plainWheelEvent.defaultPrevented).toBe(true);
            expect(setup.singlePageScroll.handleWheel).not.toHaveBeenCalled();
            expect(setup.cancelPendingSearchScroll).toHaveBeenCalled();
        } finally {
            setup.scope.stop();
        }
    });

    it('marks unhandled plain wheel packets as interrupting viewport interactions', () => {
        const setup = setupWheelZoom();

        try {
            const event = createWheelEvent({
                deltaY: 120,
                clientX: 120,
                clientY: 160,
            });

            setup.wheelZoom.handleViewerWheel(event);

            expect(setup.cancelPendingSearchScroll).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.cancelProgrammaticNavigation).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.handleWheel).toHaveBeenCalledWith(event);
            expect(setup.markUserViewportInteraction).toHaveBeenCalledOnce();
        } finally {
            setup.scope.stop();
        }
    });

    it('preserves programmatic navigation ownership for consumed single-page wheel packets', () => {
        const setup = setupWheelZoom();
        setup.singlePageScroll.handleWheel.mockReturnValue(true);

        try {
            const event = createWheelEvent({
                deltaY: 120,
                clientX: 120,
                clientY: 160,
            });

            setup.wheelZoom.handleViewerWheel(event);

            expect(setup.cancelPendingSearchScroll).toHaveBeenCalledOnce();
            expect(setup.singlePageScroll.handleWheel).toHaveBeenCalledWith(event);
            expect(setup.singlePageScroll.cancelProgrammaticNavigation).not.toHaveBeenCalled();
            expect(setup.markUserViewportInteraction).not.toHaveBeenCalled();
        } finally {
            setup.scope.stop();
        }
    });

    it('restores the captured scroll snapshot after the zoom ref changes', async () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.wheelZoom.handleViewerWheel(zoomEvent);

            setup.zoom.value = 1.25;
            await nextTick();

            expect(captureScrollSnapshot).toHaveBeenCalledOnce();
            expect(restoreScrollFromSnapshot).toHaveBeenCalledWith(
                setup.viewerContainer.value,
                {
                    anchorViewportX: 120,
                    anchorViewportY: 160,
                },
                expect.objectContaining({
                    restoreHorizontal: true,
                    restoreVertical: true,
                    preferPageAnchor: true,
                }),
            );
        } finally {
            setup.scope.stop();
        }
    });

    it('releases the virtualization freeze after the zoom session and expected scroll window settle', () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.wheelZoom.handleViewerWheel(zoomEvent);

            expect(setup.zoomVirtualizationFreeze.value).not.toBeNull();

            vi.advanceTimersByTime(2500);

            expect(setup.zoomVirtualizationFreeze.value).toBeNull();
        } finally {
            setup.scope.stop();
        }
    });

    it('clears an already-applied immediate restore intent when a later zoom packet is unchanged', async () => {
        const setup = setupWheelZoom();

        try {
            const zoomEvent = createWheelEvent({
                deltaY: -120,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.wheelZoom.handleViewerWheel(zoomEvent);
            const emittedEffectiveZoom = setup.emit.mock.calls.find(
                call => call[0] === 'update:effectiveZoom',
            )?.[1] as number | undefined;
            if (typeof emittedEffectiveZoom !== 'number') {
                throw new Error('Expected effective zoom emit');
            }
            setup.effectiveScale.value = emittedEffectiveZoom;

            const noChangeZoomEvent = createWheelEvent({
                deltaY: 0.001,
                ctrlKey: true,
                clientX: 120,
                clientY: 160,
            });
            setup.wheelZoom.handleViewerWheel(noChangeZoomEvent);

            setup.zoom.value = 1.1;
            await nextTick();

            expect(restoreScrollFromSnapshot).not.toHaveBeenCalled();
        } finally {
            setup.scope.stop();
        }
    });
});
