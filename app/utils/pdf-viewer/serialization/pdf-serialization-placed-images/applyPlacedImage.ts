import type { PDFDocument } from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
    PDFNumber,
    degrees,
    drawImage,
} from 'pdf-lib';
import { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { toPdfRectFromMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/toPdfRectFromMarkerRect';
import { appendAnnotationRefToPage } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/appendAnnotationRefToPage';
import type { IPdfSerializedPlacedImagePayload } from '@app/utils/pdf-viewer/serialization/pdf-serialization-placed-images/pdfSerializedPlacedImagePayload';
import { tryResolvePdfLibPageView } from '@pdf-core';

export async function applyPlacedImage(
    doc: PDFDocument,
    placement: IPdfSerializedPlacedImagePayload | null,
) {
    if (!placement || placement.bytes.length === 0) {
        return false;
    }

    const page = doc.getPages()[placement.pageNumber - 1];
    if (!page) {
        return false;
    }

    const pageView = tryResolvePdfLibPageView(page);
    if (!pageView) {
        return false;
    }

    const embedMimeType = placement.mimeType;
    const embeddedImage = embedMimeType === 'image/jpeg'
        ? await doc.embedJpg(placement.bytes)
        : await doc.embedPng(placement.bytes);

    const pageRotation = normalizePageRotation(page.getRotation().angle);
    const pdfRect = toPdfRectFromMarkerRect({
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
    }, pageView, pageRotation);
    if (!pdfRect) {
        return false;
    }

    const x = Math.min(pdfRect[0], pdfRect[2]);
    const y = Math.min(pdfRect[1], pdfRect[3]);
    const width = Math.abs(pdfRect[2] - pdfRect[0]);
    const height = Math.abs(pdfRect[3] - pdfRect[1]);
    if (width <= 0 || height <= 0) {
        return false;
    }

    const rotationDegrees = 0 - (placement.rotationDegrees ?? 0);
    const radians = (rotationDegrees * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    const bboxWidth = (width * absCos) + (height * absSin);
    const bboxHeight = (width * absSin) + (height * absCos);
    const bboxCenterX = bboxWidth / 2;
    const bboxCenterY = bboxHeight / 2;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotatedHalfWidth = ((width / 2) * cos) - ((height / 2) * sin);
    const rotatedHalfHeight = ((width / 2) * sin) + ((height / 2) * cos);
    const imageX = bboxCenterX - rotatedHalfWidth;
    const imageY = bboxCenterY - rotatedHalfHeight;
    const imageName = doc.context.addRandomSuffix('Image', 10);
    const appearanceRef = doc.context.register(
        doc.context.formXObject(
            drawImage(imageName, {
                x: imageX,
                y: imageY,
                width,
                height,
                rotate: degrees(rotationDegrees),
                xSkew: degrees(0),
                ySkew: degrees(0),
            }),
            {
                Resources: { XObject: { [imageName]: embeddedImage.ref } },
                BBox: doc.context.obj([
                    0,
                    0,
                    bboxWidth,
                    bboxHeight,
                ]),
                Matrix: doc.context.obj([
                    1,
                    0,
                    0,
                    1,
                    0,
                    0,
                ]),
            },
        ),
    );
    const rectOffsetX = (bboxWidth - width) / 2;
    const rectOffsetY = (bboxHeight - height) / 2;
    const stampDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: doc.context.obj([
            PDFNumber.of(x - rectOffsetX),
            PDFNumber.of(y - rectOffsetY),
            PDFNumber.of(x + width + rectOffsetX),
            PDFNumber.of(y + height + rectOffsetY),
        ]),
        AP: doc.context.obj({ N: appearanceRef }),
        F: PDFNumber.of(4),
        NM: PDFHexString.fromText(`placed-image-${crypto.randomUUID()}`),
        Name: PDFName.of('Approved'),
    });
    appendAnnotationRefToPage(page, doc, doc.context.register(stampDict));
    return true;
}
