import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { usePdfViewerPortalAnnotationHandlers } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerPortalAnnotationHandlers';
import { cast } from '@tests/helpers/cast';

function createComment(): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'stable-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'note',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'ann-1',
        source: 'editor',
    };
}

function createHandlers(options?: {
    annotationTool?: string;
    commentPlacementActive?: boolean;
}) {
    const activeCommentStableKey = {value: null as string | null};
    const emitAnnotationOpenNote = vi.fn();
    const emitAnnotationContextMenu = vi.fn();
    const contextPayload = {id: 'menu'};
    const cancelAnnotationTool = vi.fn();
    const cancelCommentPlacement = vi.fn();

    const handlers = usePdfViewerPortalAnnotationHandlers({
        activeCommentStableKey,
        suppressAnnotationId: vi.fn(),
        removeAnnotationFromDom: vi.fn(),
        refreshHiddenAnnotationPage: vi.fn(),
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
        buildAnnotationContextMenuPayload: vi.fn(() => contextPayload as never),
        handleMarkerMove: vi.fn(),
        findEditorForComment: vi.fn(() => null),
        addPendingCommentEditorKey: vi.fn(),
        getEditorPendingKey: vi.fn(() => 'editor-key'),
        markModified: vi.fn(),
        getAnnotationTool: () => options?.annotationTool ?? 'none',
        cancelAnnotationTool,
        isCommentPlacementActive: () => options?.commentPlacementActive ?? false,
        cancelCommentPlacement,
    });

    return {
        activeCommentStableKey,
        cancelAnnotationTool,
        cancelCommentPlacement,
        emitAnnotationContextMenu,
        emitAnnotationOpenNote,
        handlers,
    };
}

describe('usePdfViewerPortalAnnotationHandlers', () => {
    it('cancels active annotation modes before opening a marker note', () => {
        const comment = createComment();
        const {
            activeCommentStableKey,
            cancelAnnotationTool,
            cancelCommentPlacement,
            emitAnnotationOpenNote,
            handlers,
        } = createHandlers({
            annotationTool: 'rectangle',
            commentPlacementActive: true,
        });

        handlers.handleMarkerOpenNote(comment);

        expect(cancelAnnotationTool).toHaveBeenCalledOnce();
        expect(cancelCommentPlacement).toHaveBeenCalledOnce();
        expect(activeCommentStableKey.value).toBe('stable-1');
        expect(emitAnnotationOpenNote).toHaveBeenCalledWith(comment);
    });

    it('cancels active annotation modes before opening a marker context menu', () => {
        const comment = createComment();
        const {
            cancelAnnotationTool,
            cancelCommentPlacement,
            emitAnnotationContextMenu,
            handlers,
        } = createHandlers({
            annotationTool: 'highlight',
            commentPlacementActive: true,
        });

        handlers.handleMarkerContextMenu(comment, cast<MouseEvent>({
            clientX: 11,
            clientY: 22,
        }));

        expect(cancelAnnotationTool).toHaveBeenCalledOnce();
        expect(cancelCommentPlacement).toHaveBeenCalledOnce();
        expect(emitAnnotationContextMenu).toHaveBeenCalledOnce();
    });
});
