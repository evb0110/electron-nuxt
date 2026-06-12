import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import { collectAnnotationRefsToDelete } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/collectAnnotationRefsToDelete';

describe('collectAnnotationRefsToDelete Parent guard', () => {
    it('queues the FreeText parent when deleting a Popup whose parent is a FreeText', async () => {
        const doc = await PDFDocument.create();
        const freeTextDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('FreeText'),
        });
        const freeTextRef = doc.context.register(freeTextDict);

        const popupDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Popup'),
            Parent: freeTextRef,
        });
        const popupRef = doc.context.register(popupDict);
        freeTextDict.set(PDFName.of('Popup'), popupRef);

        const refs = collectAnnotationRefsToDelete(doc, popupRef).map(ref => ref.toString());
        expect(refs).toContain(popupRef.toString());
        expect(refs).toContain(freeTextRef.toString());
    });

    it('does not queue a Parent whose Subtype is not FreeText/Popup', async () => {
        const doc = await PDFDocument.create();
        const widgetDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Widget'),
        });
        const widgetRef = doc.context.register(widgetDict);

        const childDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Popup'),
            Parent: widgetRef,
        });
        const childRef = doc.context.register(childDict);

        const refs = collectAnnotationRefsToDelete(doc, childRef).map(ref => ref.toString());
        expect(refs).toEqual([childRef.toString()]);
        expect(refs).not.toContain(widgetRef.toString());
    });

    it('does not queue a Parent that has no Subtype', async () => {
        const doc = await PDFDocument.create();
        const parentDict = doc.context.obj({ Type: PDFName.of('Annot') });
        const parentRef = doc.context.register(parentDict);

        const childDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Popup'),
            Parent: parentRef,
        });
        const childRef = doc.context.register(childDict);

        const refs = collectAnnotationRefsToDelete(doc, childRef).map(ref => ref.toString());
        expect(refs).toEqual([childRef.toString()]);
        expect(refs).not.toContain(parentRef.toString());
    });
});
