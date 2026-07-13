import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
    PDFString,
} from 'pdf-lib';
import {applyCanonicalAnnotationIdentityBindings} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import {getPdfStringValue} from '@app/utils/pdfDict';
import {asAnnotationId} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';

function comment(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: 'editor-1',
        appAnnotationId: 'anno_new_markup',
        stableKey: 'uid:0:editor-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        subtype: 'Highlight',
        author: null,
        modifiedAt: null,
        color: '#ffff00',
        uid: 'editor-1',
        annotationId: null,
        source: 'editor',
        hasNote: false,
        markerRect: null,
        ...overrides,
    };
}

function bindingProgram(annotationId = asAnnotationId('anno_new_markup')): IBackendAnnotationMutation[] {
    return [{
        backend: 'pdf-lib-rewrite',
        order: 0,
        annotationId,
        operation: 'bind-identities',
        fields: {identity: {
            id: annotationId,
            pdfjsUid: 'editor-1',
        }},
    }];
}

function bindingPrograms(bindings: ReadonlyArray<{
    id: string;
    uid: string
}>): IBackendAnnotationMutation[] {
    return bindings.map((binding, order) => ({
        backend: 'pdf-lib-rewrite',
        order,
        annotationId: asAnnotationId(binding.id),
        operation: 'bind-identities',
        fields: {identity: {
            id: asAnnotationId(binding.id),
            pdfjsUid: binding.uid,
        }},
    }));
}

async function createDocumentWithHighlights(count: number) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        100,
        100,
    ]);
    const refs = Array.from({length: count}, () => {
        const dict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Highlight'),
            Rect: [
                10,
                10,
                20,
                20,
            ],
        });
        const ref = doc.context.register(dict);
        page.node.addAnnot(ref);
        return {
            dict,
            ref,
        };
    });
    return {
        doc,
        refs,
    };
}

describe('applyCanonicalAnnotationIdentityBindings', () => {
    it('writes the canonical app ID onto the uniquely new page/subtype record', async () => {
        const {
            doc,
            refs,
        } = await createDocumentWithHighlights(2);
        refs[0]?.dict.set(PDFName.of('NM'), PDFString.of('existing-highlight'));
        const comments = [
            comment({
                appAnnotationId: 'anno_existing',
                annotationId: `${refs[0]!.ref.objectNumber}R`,
                source: 'pdf',
            }),
            comment({}),
        ];

        const bound: Array<{
            annotationId: string;
            pdfRef: string;
        }> = [];
        expect(applyCanonicalAnnotationIdentityBindings(
            doc,
            comments,
            bindingProgram(),
            {onIdentityBound: binding => bound.push(binding)},
        )).toBe(true);
        expect(getPdfStringValue(refs[1]?.dict.get(PDFName.of('NM')))).toBe('anno_new_markup');
        expect(bound).toEqual([{
            annotationId: 'anno_new_markup',
            pdfRef: `${refs[1]!.ref.objectNumber}R`,
        }]);
    });

    it('refuses to bind when unclaimed records make the identity mapping ambiguous', async () => {
        const {doc} = await createDocumentWithHighlights(2);

        expect(() => applyCanonicalAnnotationIdentityBindings(
            doc,
            [comment({})],
            bindingProgram(),
        )).toThrow('expected 1, found 2');
    });

    it('excludes explicit pre-save refs when a third-party annotation shares the subtype', async () => {
        const {
            doc,
            refs,
        } = await createDocumentWithHighlights(2);

        expect(applyCanonicalAnnotationIdentityBindings(
            doc,
            [comment({})],
            bindingProgram(),
            {preexistingPdfAnnotationRefs: [`${refs[0]!.ref.objectNumber}R`]},
        )).toBe(true);
        expect(getPdfStringValue(refs[0]?.dict.get(PDFName.of('NM')))).toBe('');
        expect(getPdfStringValue(refs[1]?.dict.get(PDFName.of('NM')))).toBe('anno_new_markup');
    });

    it('follows explicit PDF.js editor serialization order when comments and PDF refs are reordered', async () => {
        const {
            doc,
            refs,
        } = await createDocumentWithHighlights(2);
        const annots = doc.getPages()[0]!.node.Annots()!;
        annots.set(0, refs[1]!.ref);
        annots.set(1, refs[0]!.ref);
        const programs = bindingPrograms([
            {
                id: 'anno_first',
                uid: 'pdfjs_internal_editor_1',
            },
            {
                id: 'anno_second',
                uid: 'pdfjs_internal_editor_2',
            },
        ]);
        const comments = [
            comment({
                appAnnotationId: 'anno_second',
                uid: 'pdfjs_internal_editor_2',
            }),
            comment({
                appAnnotationId: 'anno_first',
                uid: 'pdfjs_internal_editor_1',
            }),
        ];

        expect(applyCanonicalAnnotationIdentityBindings(doc, comments, programs, {newPdfJsAnnotationEditorOrder: [
            'pdfjs_internal_editor_1',
            'pdfjs_internal_editor_2',
        ]})).toBe(true);
        expect(getPdfStringValue(refs[1]?.dict.get(PDFName.of('NM')))).toBe('anno_first');
        expect(getPdfStringValue(refs[0]?.dict.get(PDFName.of('NM')))).toBe('anno_second');
    });

    it('refuses multiple same-bucket bindings without explicit editor serialization evidence', async () => {
        const {doc} = await createDocumentWithHighlights(2);
        const programs = bindingPrograms([
            {
                id: 'anno_first',
                uid: 'pdfjs_internal_editor_1',
            },
            {
                id: 'anno_second',
                uid: 'pdfjs_internal_editor_2',
            },
        ]);

        expect(() => applyCanonicalAnnotationIdentityBindings(doc, [
            comment({
                appAnnotationId: 'anno_first',
                uid: 'pdfjs_internal_editor_1',
            }),
            comment({
                appAnnotationId: 'anno_second',
                uid: 'pdfjs_internal_editor_2',
            }),
        ], programs)).toThrow('missing explicit PDF.js editor order');
    });

    it('accepts an already-bound same-bucket result without requiring editor order again', async () => {
        const {
            doc,
            refs,
        } = await createDocumentWithHighlights(2);
        refs[0]!.dict.set(PDFName.of('NM'), PDFString.of('anno_first'));
        refs[1]!.dict.set(PDFName.of('NM'), PDFString.of('anno_second'));
        const programs = bindingPrograms([
            {
                id: 'anno_first',
                uid: 'pdfjs_internal_editor_1',
            },
            {
                id: 'anno_second',
                uid: 'pdfjs_internal_editor_2',
            },
        ]);

        expect(applyCanonicalAnnotationIdentityBindings(doc, [
            comment({
                appAnnotationId: 'anno_first',
                uid: 'pdfjs_internal_editor_1',
            }),
            comment({
                appAnnotationId: 'anno_second',
                uid: 'pdfjs_internal_editor_2',
            }),
        ], programs)).toBe(false);
    });
});
