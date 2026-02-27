import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type { PDFRef } from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { resolveCommentPdfRefInDocument } from '@app/composables/pdf/pdfSerializationRefs';

vi.mock('@app/composables/pdf/pdfAnnotationUtils', () => ({ markerRectIoU: () => 0 }));

function createEditorComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'editor:0:pdfjs_internal_editor_0',
        stableKey: 'uid:0:pdfjs_internal_editor_0',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: 'pdfjs_internal_editor_0',
        annotationId: null,
        source: 'editor',
        hasNote: true,
        markerRect: null,
        kindLabel: null,
        subtype: null,
        ...overrides,
    };
}

async function createPdfWithTextAnnotations(count: number) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const annots = doc.context.obj([]);
    const refs: PDFRef[] = [];

    for (let index = 0; index < count; index += 1) {
        const left = 60 + (index * 18);
        const top = 700 - (index * 18);
        const annotDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Text'),
            Rect: [
                PDFNumber.of(left),
                PDFNumber.of(top),
                PDFNumber.of(left + 12),
                PDFNumber.of(top + 12),
            ],
        });
        const ref = doc.context.register(annotDict);
        refs.push(ref);
        annots.push(ref);
    }

    page.node.set(PDFName.of('Annots'), annots);
    return {
        doc,
        refs,
    };
}

describe('resolveCommentPdfRefInDocument', () => {
    it('falls back to the sole note-like annotation for editor comment without explicit ref', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithTextAnnotations(1);
        const resolved = resolveCommentPdfRefInDocument(doc, createEditorComment());

        expect(resolved?.toString()).toBe(refs[0]?.toString());
    });

    it('keeps editor fallback conservative when multiple note-like refs are ambiguous', async () => {
        const { doc } = await createPdfWithTextAnnotations(2);
        const resolved = resolveCommentPdfRefInDocument(doc, createEditorComment());

        expect(resolved).toBeNull();
    });
});
