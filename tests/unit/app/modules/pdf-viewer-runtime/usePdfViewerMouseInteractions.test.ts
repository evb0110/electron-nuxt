import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { computed } from 'vue';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerMouseInteractions';

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
});
