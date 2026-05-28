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

vi.mock('@app/composables/pdf/pdfPageRenderPipeline', () => ({
    captureScrollSnapshot: (...args: unknown[]) => captureScrollSnapshot(...args),
    restoreScrollFromSnapshot: (...args: unknown[]) => restoreScrollFromSnapshot(...args),
}));

vi.mock('@app/utils/browserLogger', () => {
    return { BrowserLogger: {
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
            handleWheel: vi.fn(),
            handleScroll: vi.fn(),
        };
        const cancelPendingSearchScroll = vi.fn();
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
            isSnipActive: () => false,
            emit: emit as never,
        }));

        if (!wheelZoom) {
            throw new Error('Failed to create wheel zoom composable');
        }

        return {
            scope,
            zoom,
            viewerContainer,
            zoomVirtualizationFreeze,
            singlePageScroll,
            cancelPendingSearchScroll,
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

            expect(event.defaultPrevented).toBe(true);
            expect(setup.emit).toHaveBeenCalledWith('update:zoomMode', 'custom');
            expect(setup.emit).toHaveBeenCalledWith('update:effectiveZoom', expect.any(Number));
            expect(setup.emit).toHaveBeenCalledWith('update:zoom', expect.any(Number));
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
});
