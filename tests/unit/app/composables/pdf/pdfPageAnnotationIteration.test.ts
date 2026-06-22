import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFArray,
    PDFDocument,
    PDFName,
    degrees,
} from 'pdf-lib';
import { computePointsMinMax } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/computePointsMinMax';
import { iterateAnnotationRefDicts } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/iterateAnnotationRefDicts';
import { lookupAnnotationRefDict } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/lookupAnnotationRefDict';
import { resolvePageAnnotationContext } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/resolvePageAnnotationContext';
import { appendAnnotationRefToPage } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/appendAnnotationRefToPage';

describe('pdfPageAnnotationIteration', () => {
    it('looks up annotation dictionaries only from PDF refs', async () => {
        const doc = await PDFDocument.create();
        const dict = doc.context.obj({Subtype: PDFName.of('Text')});
        const ref = doc.context.register(dict);
        const malformedRef = doc.context.register(PDFName.of('Nope'));

        expect(lookupAnnotationRefDict(doc, ref)).toEqual({
            dict,
            ref,
        });
        expect(lookupAnnotationRefDict(doc, dict)).toBeNull();
        expect(lookupAnnotationRefDict(doc, malformedRef)).toBeNull();
    });

    it('iterates annotation refs and skips inline or malformed entries', async () => {
        const doc = await PDFDocument.create();
        const first = doc.context.obj({Subtype: PDFName.of('Text')});
        const second = doc.context.obj({Subtype: PDFName.of('FreeText')});
        const firstRef = doc.context.register(first);
        const secondRef = doc.context.register(second);
        const annots = doc.context.obj([
            firstRef,
            doc.context.obj({Subtype: PDFName.of('Inline')}),
            secondRef,
        ]);

        expect(annots).toBeInstanceOf(PDFArray);
        const result = iterateAnnotationRefDicts(doc, annots);

        expect(result).toEqual([
            {
                dict: first,
                ref: firstRef,
            },
            {
                dict: second,
                ref: secondRef,
            },
        ]);
    });

    it('resolves page annotation context with page view, rotation, and Annots array', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([
            200,
            400,
        ]);
        page.setRotation(degrees(90));
        const annots = doc.context.obj([]);
        page.node.set(PDFName.of('Annots'), annots);

        const context = resolvePageAnnotationContext(page);

        expect(context?.pageView).toEqual([
            0,
            0,
            200,
            400,
        ]);
        expect(context?.pageRotation).toBe(90);
        expect(context?.annots).toBe(annots);
    });

    it('returns null page context when Annots is not an array', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage();
        page.node.set(PDFName.of('Annots'), PDFName.of('Nope'));

        expect(resolvePageAnnotationContext(page)).toBeNull();
    });

    it('replaces malformed Annots when appending a new annotation ref', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage();
        const dict = doc.context.obj({Subtype: PDFName.of('Text')});
        const ref = doc.context.register(dict);
        page.node.set(PDFName.of('Annots'), PDFName.of('Nope'));

        appendAnnotationRefToPage(page, doc, ref);

        const annots = page.node.Annots();
        expect(annots).toBeInstanceOf(PDFArray);
        expect(annots?.get(0)).toBe(ref);
    });

    it('computes point min/max bounds without mutating the input points', () => {
        const points = [
            {
                x: 3,
                y: -2,
            },
            {
                x: -1,
                y: 5,
            },
            {
                x: 2,
                y: 1,
            },
        ];

        expect(computePointsMinMax(points)).toEqual({
            minX: -1,
            minY: -2,
            maxX: 3,
            maxY: 5,
        });
        expect(points[0]).toEqual({
            x: 3,
            y: -2,
        });
    });

    it('returns null min/max bounds for empty point arrays', () => {
        expect(computePointsMinMax([])).toBeNull();
    });
});
