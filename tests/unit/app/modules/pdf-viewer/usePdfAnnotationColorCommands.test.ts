import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {shallowRef} from 'vue';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAnnotationColorCommands} from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';

function createComment(appAnnotationId: string): IAnnotationCommentSummary {
    return {
        appAnnotationId,
        id: '12R0',
        stableKey: 'ann:0:12R0',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Marked text',
        subtype: 'Underline',
        author: null,
        modifiedAt: null,
        color: '#ef4444',
        uid: null,
        annotationId: '12R0',
        source: 'pdf',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        },
    };
}

function createHarness() {
    const application = new AnnotationApplication('test');
    const id = asAnnotationId('anno-markup');
    application.store.createTextMarkup({
        kind: 'text-markup',
        identity: {
            id,
            pdfRef: '12R0',
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        subtype: 'Underline',
        contents: '',
        quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }],
        color: '#ef4444',
        opacity: 0.8,
    });
    const annotationCommentModel = {
        toTextMarkupSubtype: vi.fn(() => 'Underline' as const),
        updateCachedColor: vi.fn(),
    };
    const emitForcedAnnotationMutation = vi.fn();
    const commands = usePdfAnnotationColorCommands({
        annotationApplication: shallowRef(application),
        annotationCommentModel: annotationCommentModel as never,
        emitForcedAnnotationMutation,
    });
    return {
        application,
        commands,
        annotationCommentModel,
        emitForcedAnnotationMutation,
        comment: createComment(id),
    };
}

describe('usePdfAnnotationColorCommands', () => {
    it('updates the canonical text-markup entity for a context-menu colour change', () => {
        const harness = createHarness();

        const result = harness.commands.updateTextMarkupAnnotationColor(harness.comment, '#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldApplyTextMarkupColor: false,
            shouldRefreshPage: false,
            shouldScheduleCommentSync: true,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                color: '#22c55e',
                colorEdited: true,
            }),
        });
        expect(harness.application.store.get(asAnnotationId('anno-markup'))).toMatchObject({
            kind: 'text-markup',
            color: '#22c55e',
        });
        expect(harness.annotationCommentModel.updateCachedColor).toHaveBeenCalledWith(
            harness.comment,
            '#22c55e',
            {colorEdited: true},
        );
        expect(harness.emitForcedAnnotationMutation).toHaveBeenCalledWith({scheduleCommentSync: true});
    });

    it('updates the selected canonical text markup without a PDF.js editor', () => {
        const harness = createHarness();
        harness.application.store.select([asAnnotationId('anno-markup')]);

        const result = harness.commands.updateSelectedTextMarkupAnnotationColor('#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldScheduleCommentSync: true,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                annotationId: 'anno-markup',
                color: '#22c55e',
                subtype: 'Underline',
            }),
        });
        expect(harness.application.store.get(asAnnotationId('anno-markup'))).toMatchObject({color: '#22c55e'});
    });

    it('does not report a mutation when the selected entity is not text markup', () => {
        const application = new AnnotationApplication('test');
        application.store.select([asAnnotationId('missing')]);
        const commands = usePdfAnnotationColorCommands({
            annotationApplication: shallowRef(application),
            annotationCommentModel: {
                toTextMarkupSubtype: vi.fn(() => null),
                updateCachedColor: vi.fn(),
            } as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        expect(commands.updateSelectedTextMarkupAnnotationColor('#22c55e')).toMatchObject({updated: false});
    });
});
