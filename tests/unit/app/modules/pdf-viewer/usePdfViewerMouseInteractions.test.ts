import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { computed } from 'vue';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerMouseInteractions';

function createMouseEvent(target: EventTarget | null = null) {
    const event = new Event('contextmenu') as MouseEvent;
    Object.defineProperty(event, 'target', {
        value: target,
        configurable: true,
    });
    Object.defineProperty(event, 'preventDefault', {
        value: vi.fn(),
        configurable: true,
    });
    return event;
}

describe('usePdfViewerMouseInteractions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('always suppresses the browser context menu inside the viewer', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const handleViewerContextMenuAnnotation = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => false,
            isCommentPlacementActive: () => false,
            isViewerPanDragModeActive: computed(() => false),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart: vi.fn(),
            handleDragMove: vi.fn(),
            stopDrag: vi.fn(),
            handleViewerMouseUpAnnotation: vi.fn(),
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation,
        });

        const event = createMouseEvent();
        interactions.handleViewerContextMenu(event);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(handleViewerContextMenuAnnotation).toHaveBeenCalledWith(event);
    });

    it('still suppresses the browser context menu during snipping without delegating', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const handleViewerContextMenuAnnotation = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => true,
            isCommentPlacementActive: () => false,
            isViewerPanDragModeActive: computed(() => false),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart: vi.fn(),
            handleDragMove: vi.fn(),
            stopDrag: vi.fn(),
            handleViewerMouseUpAnnotation: vi.fn(),
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation,
        });

        const event = createMouseEvent();
        interactions.handleViewerContextMenu(event);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(handleViewerContextMenuAnnotation).not.toHaveBeenCalled();
    });

    it('suppresses pan and text-selection defaults while placing a note', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const cancelPendingSearchScroll = vi.fn();
        const handleDragStart = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => false,
            isCommentPlacementActive: () => true,
            isViewerPanDragModeActive: computed(() => true),
            cancelPendingSearchScroll,
            handleDragStart,
            handleDragMove: vi.fn(),
            stopDrag: vi.fn(),
            handleViewerMouseUpAnnotation: vi.fn(),
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation: vi.fn(),
        });

        const mouseDownEvent = createMouseEvent();
        interactions.handleViewerMouseDown(mouseDownEvent);

        expect(mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
        expect(cancelPendingSearchScroll).toHaveBeenCalledOnce();
        expect(handleDragStart).not.toHaveBeenCalled();

        const selectStartEvent = createMouseEvent();
        interactions.handleSelectStart(selectStartEvent);

        expect(selectStartEvent.preventDefault).toHaveBeenCalledOnce();
    });

    it('stops pan drag on mouseup inside the viewer', () => {
        vi.stubGlobal('HTMLElement', class HTMLElementStub {
            closest() {
                return null;
            }
        });
        const stopDrag = vi.fn();
        const handleViewerMouseUpAnnotation = vi.fn();
        const interactions = usePdfViewerMouseInteractions({
            isSnipActive: () => false,
            isCommentPlacementActive: () => false,
            isViewerPanDragModeActive: computed(() => true),
            cancelPendingSearchScroll: vi.fn(),
            handleDragStart: vi.fn(),
            handleDragMove: vi.fn(),
            stopDrag,
            handleViewerMouseUpAnnotation,
            handleViewerClickAnnotation: vi.fn(),
            handleViewerDblClickAnnotation: vi.fn(),
            handleViewerContextMenuAnnotation: vi.fn(),
        });

        const event = createMouseEvent();
        interactions.handleViewerMouseUp(event);

        expect(stopDrag).toHaveBeenCalledOnce();
        expect(handleViewerMouseUpAnnotation).toHaveBeenCalledOnce();
    });
});
