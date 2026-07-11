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
import type {IUseAnnotationMutationServiceOptions} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationService.types';
import {asAnnotationId} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import type { ITextMarkupColorMutationResult } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import { cast } from '@tests/helpers/cast';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'ann:0:stable-1',
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
        markModified: vi.fn(),
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
            stableKey: 'ann:0:stable-delete',
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
            stableKey: 'ann:0:stable-delete',
            annotationId: '18R0',
            commentSnapshot: comment,
        })]);
        expect(options.removeAnnotationFromInternalCache).toHaveBeenCalledWith('ann:0:stable-delete');
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
            stableKey: 'ann:0:stable-color',
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
                stableKey: 'ann:0:stable-color',
                annotationId: '12R0',
                pageNumber: 1,
                commentSnapshot: updatedComment,
                color: '#22c55e',
                sourceColor: '#ef4444',
            }),
            expect.objectContaining({
                id: 2,
                kind: 'render-page-text-markup',
                stableKey: 'ann:0:stable-color',
                annotationId: '12R0',
                pageNumber: 1,
                commentSnapshot: updatedComment,
            }),
        ]);
    });

    it('does not enqueue duplicate text-markup overlay work for connected highlights', () => {
        const comment = createComment({
            stableKey: 'ann:0:stable-highlight',
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
            stableKey: 'ann:0:stable-highlight',
            annotationId: '14R0',
        })]);
    });

    it('updates moved note marker editor anchors before dirtying the viewer', () => {
        const comment = createComment({ pageIndex: 2 });
        const markerRect = createMarkerRect();
        const editor = createEditor();
        const markModified = vi.fn();
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
        expect(getPdfjsEditorFacadeState(editor).pendingAnchorRect).toEqual(markerRect);
        expect(markModified).toHaveBeenCalledOnce();
        expect(service.visualEffects.effects.value).toEqual([]);
    });

    it('exposes the canonical save flush hook', async () => {
        const options = createOptions({flushAnnotationCommentsForSave: vi.fn(async () => 'flushed')});
        const service = useAnnotationMutationService(options);

        await expect(service.flushForSave()).resolves.toBe('flushed');
        expect(options.flushAnnotationCommentsForSave).toHaveBeenCalledOnce();
    });

    it('routes deferred delete and undo directly through the canonical store', () => {
        const comment = createComment();
        const annotationId = asAnnotationId('annotation-1');
        const options = createOptions({
            resolveCanonicalAnnotationId: vi.fn(() => annotationId),
            deleteCanonicalAnnotation: vi.fn(),
        });
        const service = useAnnotationMutationService(options);

        expect(service.deleteEmbeddedAnnotationDeferred(comment)).toBe(true);
        expect(options.deleteCanonicalAnnotation).toHaveBeenCalledWith(annotationId);
    });
});
