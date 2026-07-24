import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { useAnnotationMutationService } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import type { IUseAnnotationMutationServiceOptions } from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationService.types';
import { asAnnotationId } from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';

function createComment(): IAnnotationCommentSummary {
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
    };
}

function createOptions(
    overrides: Partial<IUseAnnotationMutationServiceOptions> = {},
): IUseAnnotationMutationServiceOptions {
    return {
        updateAnnotationComment: vi.fn(() => true),
        deleteAnnotationComment: vi.fn(async () => true),
        updateSelectedTextMarkupAnnotationColor: vi.fn(),
        updateTextMarkupAnnotationColor: vi.fn(),
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

describe('useAnnotationMutationService invariants', () => {
    it('captures canonical identity before PDF.js deletion invalidates the projection', async () => {
        const annotationId = asAnnotationId('annotation-before-delete');
        let projectionAvailable = true;
        const options = createOptions({
            resolveCanonicalAnnotationId: vi.fn(() => projectionAvailable ? annotationId : null),
            deleteAnnotationComment: vi.fn(async () => {
                projectionAvailable = false;
                return true;
            }),
            deleteCanonicalAnnotation: vi.fn(),
        });
        const service = useAnnotationMutationService(options);

        await expect(service.deleteAnnotation(
            {comment: createComment()},
            {source: 'user'},
        )).resolves.toBe(true);

        expect(options.resolveCanonicalAnnotationId).toHaveBeenCalledOnce();
        expect(options.deleteCanonicalAnnotation).toHaveBeenCalledWith(annotationId);
    });

    it('does not enqueue duplicate overlay work when a connected highlight owns its paint', () => {
        const comment = {
            ...createComment(),
            annotationId: '14R0',
            subtype: 'Highlight' as const,
        };
        const options = createOptions({updateTextMarkupAnnotationColor: vi.fn(() => ({
            updated: true,
            shouldScheduleCommentSync: true,
            shouldRefreshPage: true,
            shouldApplyTextMarkupColor: false,
            comment: {
                ...comment,
                color: '#22c55e',
            },
            sourceColor: null,
        }))});
        const service = useAnnotationMutationService(options);

        expect(service.updateColor(
            {
                comment,
                color: '#22c55e',
            },
            {source: 'user'},
        )).toBe(true);
        expect(service.visualEffects.effects.value).toEqual([expect.objectContaining({
            kind: 'render-page-text-markup',
            annotationId: '14R0',
        })]);
    });
});
