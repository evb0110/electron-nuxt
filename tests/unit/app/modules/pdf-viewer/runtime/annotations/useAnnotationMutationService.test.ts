import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    useAnnotationMutationService,
    type IUseAnnotationMutationServiceOptions,
} from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

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
        resolveCanonicalAnnotationId: vi.fn(() => asAnnotationId('canonical-annotation')),
        setCanonicalNoteText: vi.fn(),
        deleteCanonicalAnnotation: vi.fn(),
        setCanonicalColor: vi.fn(),
        moveCanonicalAnchor: vi.fn(),
        ...overrides,
    };
}

describe('useAnnotationMutationService canonical command ordering', () => {
    it('commits a comment before the one-shot PDF.js projection', () => {
        const events: string[] = [];
        const options = createOptions({
            setCanonicalNoteText: vi.fn(() => events.push('store')),
            updateAnnotationComment: vi.fn(() => {
                events.push('pdfjs');
                return false;
            }),
        });
        const service = useAnnotationMutationService(options);

        expect(service.updateComment(
            {
                comment: createComment(),
                text: 'updated',
            },
            {source: 'user'},
        )).toBe(true);
        expect(events).toEqual([
            'store',
            'pdfjs',
        ]);
        expect(options.setCanonicalNoteText).toHaveBeenCalledOnce();
        expect(options.updateAnnotationComment).toHaveBeenCalledOnce();
    });

    it('tombstones canonically before async PDF.js delete and queues removal even when projection misses', async () => {
        const events: string[] = [];
        const options = createOptions({
            deleteCanonicalAnnotation: vi.fn(() => events.push('store')),
            deleteAnnotationComment: vi.fn(async () => {
                events.push('pdfjs');
                return false;
            }),
        });
        const service = useAnnotationMutationService(options);

        await expect(service.deleteAnnotation(
            {comment: createComment()},
            {source: 'user'},
        )).resolves.toBe(true);
        expect(events).toEqual([
            'store',
            'pdfjs',
        ]);
        expect(options.deleteCanonicalAnnotation).toHaveBeenCalledOnce();
        expect(service.visualEffects.effects.value).toEqual(
            [expect.objectContaining({kind: 'annotation-dom-removal'})],
        );
    });

    it('does not tombstone a PDF-backed FreeText when its live editor stays attached', async () => {
        const comment: IAnnotationCommentSummary = {
            ...createComment(),
            source: 'editor',
            annotationId: '44R',
            subtype: 'FreeText',
        };
        const options = createOptions({deleteAnnotationComment: vi.fn(async () => false)});
        const service = useAnnotationMutationService(options);

        await expect(service.deleteAnnotation(
            {comment},
            {source: 'user'},
        )).resolves.toBe(false);

        expect(options.deleteCanonicalAnnotation).not.toHaveBeenCalled();
        expect(service.visualEffects.effects.value).toEqual([]);
    });

    it('groups reopened FreeText editor removal and canonical tombstone in one history transaction', async () => {
        const events: string[] = [];
        let transactionCount = 0;
        const runHistoryTransaction: NonNullable<IUseAnnotationMutationServiceOptions['runHistoryTransaction']> =
            <T>(action: () => T): T => {
                transactionCount += 1;
                events.push('transaction-start');
                const result = action();
                if (result instanceof Promise) {
                    return result.finally(() => events.push('transaction-end')) as T;
                }
                events.push('transaction-end');
                return result;
            };
        const options = createOptions({
            runHistoryTransaction,
            deleteAnnotationComment: vi.fn(async () => {
                events.push('pdfjs-editor');
                return true;
            }),
            deleteCanonicalAnnotation: vi.fn(() => events.push('store')),
        });
        const service = useAnnotationMutationService(options);

        await expect(service.deleteReopenedEditorAnnotation(
            {comment: createComment()},
            {source: 'user'},
        )).resolves.toBe(true);

        expect(events).toEqual([
            'transaction-start',
            'pdfjs-editor',
            'store',
            'transaction-end',
        ]);
        expect(transactionCount).toBe(1);
        expect(service.visualEffects.effects.value).toEqual(
            [expect.objectContaining({kind: 'annotation-dom-removal'})],
        );
    });

    it('joins persisted PDF FreeText editor removal to its canonical tombstone', async () => {
        const events: string[] = [];
        let editorAttached = true;
        const comment: IAnnotationCommentSummary = {
            ...createComment(),
            id: '44R',
            stableKey: 'ann:0:44R',
            annotationId: '44R',
            source: 'pdf',
            subtype: 'FreeText',
        };
        const options = createOptions({
            deleteAnnotationComment: vi.fn(async (input) => {
                events.push(`editor:${input.annotationId}`);
                editorAttached = false;
                return true;
            }),
            deleteCanonicalAnnotation: vi.fn(() => {
                events.push('canonical');
            }),
        });
        const service = useAnnotationMutationService(options);

        await expect(service.deleteReopenedEditorAnnotation(
            {comment},
            {source: 'user'},
        )).resolves.toBe(true);

        expect(editorAttached).toBe(false);
        expect(events).toEqual([
            'editor:44R',
            'canonical',
        ]);
        expect(options.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(options.deleteCanonicalAnnotation).toHaveBeenCalledWith(asAnnotationId('canonical-annotation'));
    });

    it.each([
        [
            'returns false',
            vi.fn(async () => false),
        ],
        [
            'throws',
            vi.fn(async () => { throw new Error('editor delete failed'); }),
        ],
    ])('does not tombstone when reopened FreeText editor removal %s', async (_label, deleteEditor) => {
        const options = createOptions({deleteAnnotationComment: deleteEditor});
        const service = useAnnotationMutationService(options);

        await expect(service.deleteReopenedEditorAnnotation(
            {comment: createComment()},
            {source: 'user'},
        )).resolves.toBe(false);

        expect(options.deleteCanonicalAnnotation).not.toHaveBeenCalled();
        expect(service.visualEffects.effects.value).toEqual([]);
    });

    it('commits color and marker movement before their PDF.js projections', () => {
        const colorEvents: string[] = [];
        const moveEvents: string[] = [];
        const comment = createComment();
        const options = createOptions({
            setCanonicalColor: vi.fn(() => colorEvents.push('store')),
            updateTextMarkupAnnotationColor: vi.fn(() => {
                colorEvents.push('pdfjs');
                return {
                    updated: true,
                    shouldScheduleCommentSync: false,
                    shouldRefreshPage: false,
                    shouldApplyTextMarkupColor: false,
                    comment,
                    sourceColor: null,
                };
            }),
            moveCanonicalAnchor: vi.fn(() => moveEvents.push('store')),
            handleMarkerMove: vi.fn(() => {
                moveEvents.push('pdfjs');
                return true;
            }),
        });
        const service = useAnnotationMutationService(options);

        expect(service.updateColor(
            {
                comment,
                color: '#22c55e',
            },
            {source: 'user'},
        )).toBe(true);
        expect(service.moveMarker(
            {
                comment,
                rect: {
                    left: 0.2,
                    top: 0.3,
                    width: 0.1,
                    height: 0.1,
                },
            },
            {source: 'user'},
        )).toBe(true);

        expect(colorEvents).toEqual([
            'store',
            'pdfjs',
        ]);
        expect(moveEvents).toEqual([
            'store',
            'pdfjs',
        ]);
    });

    it('keeps imported sticky-note moves out of PDF.js live storage while publishing dirty state', () => {
        const comment: IAnnotationCommentSummary = {
            ...createComment(),
            annotationId: '12R',
            hasNote: true,
            source: 'pdf',
            subtype: 'FreeText',
        };
        const editor = {};
        const findEditorForComment = vi.fn(() => editor);
        const markModified = vi.fn();
        const handleMarkerMove = vi.fn((
            current: IAnnotationCommentSummary,
            markerRect: NonNullable<IAnnotationCommentSummary['markerRect']>,
            moveOptions?: Parameters<IUseAnnotationMutationServiceOptions['handleMarkerMove']>[2],
        ) => {
            moveOptions?.markEditorPending?.(current, current, markerRect);
            moveOptions?.markModified?.();
            return true;
        });
        const options = createOptions({
            findEditorForComment,
            handleMarkerMove,
            markModified,
        });
        const service = useAnnotationMutationService(options);

        expect(service.moveMarker(
            {
                comment,
                rect: {
                    left: 0.2,
                    top: 0.3,
                    width: 0.015,
                    height: 0.015,
                },
            },
            {source: 'user'},
        )).toBe(true);

        expect(options.moveCanonicalAnchor).toHaveBeenCalledOnce();
        expect(findEditorForComment).not.toHaveBeenCalled();
        expect(markModified).toHaveBeenCalledOnce();
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
