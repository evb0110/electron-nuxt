import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { useAnnotationMutationService } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import type {
    IConsumedAnnotationEmbeddedMutations,
    IUseAnnotationMutationServiceOptions,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationService.types';
import type { ITextMarkupColorMutationResult } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import { cast } from '@tests/helpers/cast';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
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
        ...overrides,
    };
}

function createMarkerRect(): IAnnotationMarkerRect {
    return {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.4,
    };
}

function createEditor(): IPdfjsEditor {
    return cast<IPdfjsEditor>({
        div: {
            classList: {add: vi.fn()},
            setAttribute: vi.fn(),
            querySelector: vi.fn(() => null),
            style: {},
        },
        setDims: vi.fn(),
        fixAndSetPosition: vi.fn(),
    });
}

function createColorMutationResult(
    comment: IAnnotationCommentSummary | null = createComment(),
    overrides: Partial<ITextMarkupColorMutationResult> = {},
): ITextMarkupColorMutationResult {
    return {
        updated: true,
        shouldScheduleCommentSync: true,
        shouldRefreshPage: true,
        shouldApplyTextMarkupColor: true,
        comment,
        sourceColor: comment?.color ?? null,
        ...overrides,
    };
}

function createOptions(
    overrides: Partial<IUseAnnotationMutationServiceOptions> = {},
): IUseAnnotationMutationServiceOptions {
    return {
        updateAnnotationComment: vi.fn(() => true),
        deleteAnnotationComment: vi.fn(async () => true),
        updateSelectedTextMarkupAnnotationColor: vi.fn(() => createColorMutationResult()),
        updateTextMarkupAnnotationColor: vi.fn(comment => createColorMutationResult(comment)),
        markAnnotationLocallyDeleted: vi.fn(),
        restoreAnnotationLocally: vi.fn(),
        removeAnnotationFromInternalCache: vi.fn(),
        findAnnotationCommentByStableKey: vi.fn(() => null),
        clearPendingMarkerMoves: vi.fn(),
        handleMarkerMove: vi.fn(() => true),
        findEditorForComment: vi.fn(() => null),
        addPendingCommentEditorKey: vi.fn(),
        getEditorPendingKey: vi.fn(() => 'pending-editor-key'),
        markModified: vi.fn(),
        suppressManagedAnnotationId: vi.fn(),
        unsuppressManagedAnnotationId: vi.fn(),
        suppressCommentAnnotationId: vi.fn(),
        unsuppressCommentAnnotationId: vi.fn(),
        suppressAnnotationStableKey: vi.fn(),
        unsuppressAnnotationStableKey: vi.fn(),
        flushAnnotationCommentsForSave: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('useAnnotationMutationService', () => {
    it('routes comment updates and deletes through the existing mutation owners', async () => {
        const comment = createComment();
        const options = createOptions();
        const service = useAnnotationMutationService(options);

        expect(service.updateComment(
            {
                comment,
                text: 'updated',
            },
            { source: 'note-window' },
        )).toBe(true);
        await expect(service.deleteAnnotation(
            { comment },
            { source: 'user' },
        )).resolves.toBe(true);
        await expect(service.deleteAnnotation(
            {
                comment,
                strategy: 'local-only',
            },
            { source: 'save-reload' },
        )).resolves.toBe(true);

        expect(options.updateAnnotationComment).toHaveBeenCalledWith(comment, 'updated');
        expect(options.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(options.markAnnotationLocallyDeleted).toHaveBeenCalledWith(comment);
    });

    it('enqueues deletion visual effects from delete and internal-cache removal paths', async () => {
        const comment = createComment({
            stableKey: 'stable-delete',
            annotationId: '18R0',
        });
        const options = createOptions({findAnnotationCommentByStableKey: vi.fn(() => comment)});
        const service = useAnnotationMutationService(options);

        await expect(service.deleteAnnotation(
            { comment },
            { source: 'user' },
        )).resolves.toBe(true);
        service.removeAnnotationFromInternalCache(comment.stableKey, { source: 'user' });

        expect(service.visualEffects.effects.value).toEqual([expect.objectContaining({
            id: 1,
            kind: 'annotation-dom-removal',
            stableKey: 'stable-delete',
            annotationId: '18R0',
            commentSnapshot: comment,
        })]);
        expect(options.removeAnnotationFromInternalCache).toHaveBeenCalledWith('stable-delete');
    });

    it('routes selected and comment-scoped color mutations', () => {
        const comment = createComment();
        const options = createOptions();
        const service = useAnnotationMutationService(options);

        expect(service.updateColor(
            {
                color: '#22c55e',
                selected: true,
            },
            { source: 'user' },
        )).toBe(true);
        expect(service.updateColor(
            {
                comment,
                color: '#ef4444',
            },
            { source: 'user' },
        )).toBe(true);
        expect(service.updateColor(
            { color: '#111827' },
            { source: 'user' },
        )).toBe(false);

        expect(options.updateSelectedTextMarkupAnnotationColor).toHaveBeenCalledWith('#22c55e');
        expect(options.updateTextMarkupAnnotationColor).toHaveBeenCalledWith(comment, '#ef4444');
    });

    it('enqueues derived visual effects for safe color mutations', () => {
        const comment = createComment({
            stableKey: 'stable-color',
            annotationId: '12R0',
            color: '#ef4444',
        });
        const updatedComment = {
            ...comment,
            color: '#22c55e',
        };
        const options = createOptions({updateTextMarkupAnnotationColor: vi.fn(() => createColorMutationResult(updatedComment, {sourceColor: '#ef4444'}))});
        const service = useAnnotationMutationService(options);

        expect(service.updateColor(
            {
                comment,
                color: '#22c55e',
            },
            { source: 'user' },
        )).toBe(true);

        expect(service.visualEffects.effects.value).toEqual([
            expect.objectContaining({
                id: 1,
                kind: 'text-markup-color',
                stableKey: 'stable-color',
                annotationId: '12R0',
                pageNumber: 1,
                commentSnapshot: updatedComment,
                color: '#22c55e',
                sourceColor: '#ef4444',
            }),
            expect.objectContaining({
                id: 2,
                kind: 'render-page-text-markup',
                stableKey: 'stable-color',
                annotationId: '12R0',
                pageNumber: 1,
                commentSnapshot: updatedComment,
            }),
        ]);
    });

    it('does not enqueue duplicate text-markup overlay work for connected highlights', () => {
        const comment = createComment({
            stableKey: 'stable-highlight',
            annotationId: '14R0',
            subtype: 'Highlight',
        });
        const options = createOptions({updateTextMarkupAnnotationColor: vi.fn(() => createColorMutationResult(
            {
                ...comment,
                color: '#22c55e',
            },
            { shouldApplyTextMarkupColor: false },
        ))});
        const service = useAnnotationMutationService(options);

        expect(service.updateColor(
            {
                comment,
                color: '#22c55e',
            },
            { source: 'user' },
        )).toBe(true);

        expect(service.visualEffects.effects.value).toEqual([expect.objectContaining({
            kind: 'render-page-text-markup',
            stableKey: 'stable-highlight',
            annotationId: '14R0',
        })]);
    });

    it('preserves current annotation suppression fan-out', () => {
        const options = createOptions();
        const service = useAnnotationMutationService(options);

        service.suppressAnnotation({
            annotationId: '12R0',
            stableKey: 'stable-1',
        });
        service.unsuppressAnnotation({
            annotationId: '12R0',
            stableKey: 'stable-1',
        });

        expect(options.suppressAnnotationStableKey).toHaveBeenCalledWith('stable-1');
        expect(options.suppressManagedAnnotationId).toHaveBeenCalledWith('12R0');
        expect(options.suppressCommentAnnotationId).not.toHaveBeenCalled();
        expect(options.unsuppressAnnotationStableKey).toHaveBeenCalledWith('stable-1');
        expect(options.unsuppressManagedAnnotationId).toHaveBeenCalledWith('12R0');
        expect(options.unsuppressCommentAnnotationId).toHaveBeenCalledWith('12R0');
    });

    it('marks moved note marker editors pending before dirtying the viewer', () => {
        const comment = createComment({ pageIndex: 2 });
        const markerRect = createMarkerRect();
        const editor = createEditor();
        const markModified = vi.fn();
        const addPendingCommentEditorKey = vi.fn();
        const handleMarkerMove = vi.fn((
            movedComment,
            movedRect,
            moveOptions,
        ) => {
            moveOptions?.markEditorPending?.(movedComment, comment, movedRect);
            moveOptions?.markModified?.();
            return true;
        });
        const options = createOptions({
            handleMarkerMove,
            findEditorForComment: vi.fn(() => editor),
            addPendingCommentEditorKey,
            getEditorPendingKey: vi.fn(() => 'editor:2:ann-1'),
            markModified,
        });
        const service = useAnnotationMutationService(options);

        expect(service.moveMarker(
            {
                comment,
                rect: markerRect,
            },
            { source: 'user' },
        )).toBe(true);

        expect(handleMarkerMove).toHaveBeenCalledWith(comment, markerRect, expect.any(Object));
        expect(editor.__evbPendingAnchorRect).toEqual(markerRect);
        expect(addPendingCommentEditorKey).toHaveBeenCalledWith('editor:2:ann-1');
        expect(markModified).toHaveBeenCalledOnce();
        expect(service.visualEffects.effects.value).toEqual([]);
    });

    it('exposes save flush and pending embedded mutation consumption hooks', async () => {
        const consumed: IConsumedAnnotationEmbeddedMutations = {
            pendingEmbeddedTextUpdates: new Map<string, string>().set('stable-1', 'updated'),
            pendingEmbeddedAnnotationDeletes: [createComment()],
            restore: vi.fn(),
            commit: vi.fn(),
        };
        const options = createOptions({
            flushAnnotationCommentsForSave: vi.fn(async () => 'flushed'),
            consumePendingEmbeddedMutations: vi.fn(() => consumed),
        });
        const service = useAnnotationMutationService(options);

        await expect(service.flushForSave()).resolves.toBe('flushed');
        expect(service.consumePendingEmbeddedMutations()).toBe(consumed);

        expect(options.flushAnnotationCommentsForSave).toHaveBeenCalledOnce();
        expect(options.consumePendingEmbeddedMutations).toHaveBeenCalledOnce();
    });

    it('owns pending embedded text and delete queues with restoreable consumption', () => {
        const comment = createComment();
        const options = createOptions();
        const service = useAnnotationMutationService(options);

        expect(service.queuePendingEmbeddedTextUpdate({
            comment,
            text: 'updated',
        })).toBe(true);
        expect(service.queuePendingEmbeddedAnnotationDelete(comment)).toBe(true);

        const queuedSnapshot = service.getPendingEmbeddedMutationSnapshot();
        expect(queuedSnapshot.pendingEmbeddedTextUpdates.get(comment.stableKey)).toBe('updated');
        expect(queuedSnapshot.pendingEmbeddedAnnotationDeletes).toEqual([comment]);
        expect(service.pendingEmbeddedMutationVersion.value).toBeGreaterThan(0);

        const consumed = service.consumePendingEmbeddedMutations();
        expect(consumed.pendingEmbeddedTextUpdates.get(comment.stableKey)).toBe('updated');
        expect(consumed.pendingEmbeddedAnnotationDeletes).toEqual([comment]);
        expect(service.getPendingEmbeddedMutationSnapshot().pendingEmbeddedTextUpdates.size).toBe(0);
        expect(service.getPendingEmbeddedMutationSnapshot().pendingEmbeddedAnnotationDeletes).toEqual([]);

        consumed.restore();
        const restoredSnapshot = service.getPendingEmbeddedMutationSnapshot();
        expect(restoredSnapshot.pendingEmbeddedTextUpdates.get(comment.stableKey)).toBe('updated');
        expect(restoredSnapshot.pendingEmbeddedAnnotationDeletes).toEqual([comment]);
    });
});
