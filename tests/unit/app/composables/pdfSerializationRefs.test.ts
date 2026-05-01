import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type {
    PDFObject,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    formatPdfJsAnnotationRef,
    resolveCommentPdfRefInDocument,
} from '@app/composables/pdf/pdfSerializationRefs';

type TLiteralObject = { [key: string]: PDFObject | string | number | boolean | null | undefined | TLiteralObject | TLiteralArray };
type TLiteralArray = Array<PDFObject | string | number | boolean | null | undefined | TLiteralObject | TLiteralArray>;

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

function createPdfComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'pdf:0:1',
        stableKey: 'uid:0:1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: '1',
        annotationId: null,
        source: 'pdf',
        hasNote: false,
        markerRect: null,
        kindLabel: null,
        subtype: null,
        ...overrides,
    };
}

interface IAnnotationFixture {
    subtype?: string;
    contents?: string;
    author?: string;
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

async function createPdfWithFixtures(fixtures: IAnnotationFixture[]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const annots = doc.context.obj([]);
    const refs: PDFRef[] = [];

    fixtures.forEach((fixture, index) => {
        const left = 60 + (index * 18);
        const top = 700 - (index * 18);
        const annotShape: TLiteralObject = {
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of(fixture.subtype ?? 'Text'),
            Rect: [
                PDFNumber.of(left),
                PDFNumber.of(top),
                PDFNumber.of(left + 12),
                PDFNumber.of(top + 12),
            ],
        };
        if (fixture.contents !== undefined) {
            annotShape.Contents = PDFHexString.fromText(fixture.contents);
        }
        if (fixture.author !== undefined) {
            annotShape.T = PDFHexString.fromText(fixture.author);
        }
        const annotDict = doc.context.obj(annotShape);
        const ref = doc.context.register(annotDict);
        refs.push(ref);
        annots.push(ref);
    });

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

    it('returns the explicit ref when annotationId resolves on the page (priority over scoring)', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
        ]);
        const targetRef = refs[1];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                annotationId: formatPdfJsAnnotationRef(targetRef),
                text: 'alpha',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('uses generated pdf-page-index id when explicit ref is unavailable', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
        ]);
        const targetRef = refs[1];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf-1-1',
                text: 'alpha',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('chooses by exact text match when explicit and generated lookups fail', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
            { contents: 'gamma' },
        ]);
        const targetRef = refs[1];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf:0:beta',
                text: 'beta',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('returns null for non-editor comments when no candidate clears the score threshold', async () => {
        const { doc } = await createPdfWithFixtures([
            { contents: 'alpha' },
            { contents: 'beta' },
        ]);

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createPdfComment({
                id: 'pdf:0:zeta',
                text: '',
            }),
        );

        expect(resolved).toBeNull();
    });

    it('prefers a unique editor candidate by author tie-break when text is empty', async () => {
        const {
            doc,
            refs,
        } = await createPdfWithFixtures([
            {
                contents: '',
                author: 'alice',
            },
            {
                contents: 'noise',
                author: 'bob',
            },
        ]);
        const targetRef = refs[0];
        if (!targetRef) {
            throw new Error('expected ref');
        }

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createEditorComment({
                author: 'alice',
                text: '',
            }),
        );

        expect(resolved?.toString()).toBe(targetRef.toString());
    });

    it('returns null for editor fallback when best margin over second-best is too small', async () => {
        const { doc } = await createPdfWithFixtures([
            {
                subtype: 'FreeText',
                contents: '',
            },
            {
                subtype: 'FreeText',
                contents: '',
            },
        ]);

        const resolved = resolveCommentPdfRefInDocument(
            doc,
            createEditorComment({
                text: '',
                subtype: null,
            }),
        );

        expect(resolved).toBeNull();
    });
});
