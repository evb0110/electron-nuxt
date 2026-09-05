import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFStream,
    PDFString,
    degrees,
    drawImage,
} from 'pdf-lib';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toPdfRectFromMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfRectFromMarkerRect';
import { appendAnnotationRefToPage } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/appendAnnotationRefToPage';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import type { IPdfSerializedPlacedImagePayload } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-placed-images/pdfSerializedPlacedImagePayload';
import {
    safePdfPageAnnots,
    tryResolvePdfLibPageView,
} from '@pdf-core';

function resolvePlacedImageRef(
    doc: PDFDocument,
    page: ReturnType<PDFDocument['getPages']>[number],
    placement: IPdfSerializedPlacedImagePayload,
) {
    const refs = safePdfPageAnnots(page)?.asArray()
        .filter((value): value is PDFRef => value instanceof PDFRef) ?? [];
    const requestedRef = parsePdfJsAnnotationRef(placement.annotationId);
    if (requestedRef) {
        const ref = PDFRef.of(requestedRef.objectNumber, requestedRef.generationNumber);
        if (!refs.some(candidate => candidate.objectNumber === ref.objectNumber && candidate.generationNumber === ref.generationNumber)) {
            throw new Error('Unable to update placed image: annotation is not owned by the requested page');
        }
        const dict = doc.context.lookupMaybe(ref, PDFDict);
        if (dict?.get(PDFName.of('Subtype'))?.toString() !== '/Stamp') {
            throw new Error('Unable to update placed image: target is not a Stamp annotation');
        }
        if (placement.stableKey) {
            const name = dict.get(PDFName.of('NM'));
            if (
                !(name instanceof PDFHexString || name instanceof PDFString)
                || name.decodeText() !== placement.stableKey
            ) {
                throw new Error('Unable to update placed image: stable identity does not match the target Stamp');
            }
        }
        return ref;
    }
    if (!placement.stableKey) {
        return null;
    }
    const matches = refs.filter((ref) => {
        const dict = doc.context.lookupMaybe(ref, PDFDict);
        const name = dict?.get(PDFName.of('NM'));
        return dict?.get(PDFName.of('Subtype'))?.toString() === '/Stamp'
            && (name instanceof PDFHexString || name instanceof PDFString)
            && name.decodeText() === placement.stableKey;
    });
    if (matches.length > 1) {
        throw new Error('Unable to update placed image: stable identity matched more than one Stamp annotation');
    }
    return matches[0] ?? null;
}

function resolvePlacedImageAppearanceRefs(doc: PDFDocument, stampRef: PDFRef) {
    const stamp = doc.context.lookupMaybe(stampRef, PDFDict);
    const appearance = stamp?.lookupMaybe(PDFName.of('AP'), PDFDict);
    const appearanceRef = appearance?.get(PDFName.of('N'));
    if (!(appearanceRef instanceof PDFRef)) {
        return null;
    }
    const appearanceStream = doc.context.lookupMaybe(appearanceRef, PDFStream);
    const resources = appearanceStream?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const imageRef = xobjects?.values().find((value): value is PDFRef => value instanceof PDFRef);
    return appearanceStream && xobjects && imageRef
        ? {
            appearanceRef,
            imageRef,
        }
        : null;
}

export async function applyPlacedImage(
    doc: PDFDocument,
    placement: IPdfSerializedPlacedImagePayload | null,
) {
    if (!placement) {
        return false;
    }
    if (placement.bytes.length === 0) {
        throw new Error('Unable to apply placed image: image payload is empty');
    }

    const page = doc.getPages()[placement.pageNumber - 1];
    if (!page) {
        throw new Error(`Unable to apply placed image: page ${placement.pageNumber} does not exist`);
    }

    const pageView = tryResolvePdfLibPageView(page);
    if (!pageView) {
        throw new Error(`Unable to apply placed image: page ${placement.pageNumber} view is unavailable`);
    }

    const existingRef = resolvePlacedImageRef(doc, page, placement);
    const existingAppearance = existingRef
        ? resolvePlacedImageAppearanceRefs(doc, existingRef)
        : null;
    if (existingRef && !existingAppearance) {
        throw new Error('Unable to update placed image: managed appearance resources are unavailable');
    }

    const embedMimeType = placement.mimeType;
    const embeddedImage = embedMimeType === 'image/jpeg'
        ? await doc.embedJpg(placement.bytes)
        : await doc.embedPng(placement.bytes);
    if (existingAppearance) {
        await doc.flush();
    }

    const pageRotation = normalizePageRotation(page.getRotation().angle);
    const pdfRect = toPdfRectFromMarkerRect({
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
    }, pageView, pageRotation);
    if (!pdfRect) {
        throw new Error('Unable to apply placed image: placement rectangle is invalid');
    }

    const x = Math.min(pdfRect[0], pdfRect[2]);
    const y = Math.min(pdfRect[1], pdfRect[3]);
    const width = Math.abs(pdfRect[2] - pdfRect[0]);
    const height = Math.abs(pdfRect[3] - pdfRect[1]);
    if (width <= 0 || height <= 0) {
        throw new Error('Unable to apply placed image: placement rectangle has no area');
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
    let liveAppearanceRef = appearanceRef;
    if (existingAppearance) {
        const newImage = doc.context.lookup(embeddedImage.ref, PDFStream);
        const newAppearance = doc.context.lookupMaybe(appearanceRef, PDFStream);
        const resources = newAppearance?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
        const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        const imageKey = xobjects?.keys()[0];
        if (!newAppearance || !xobjects || !imageKey) {
            throw new Error('Unable to update placed image: replacement appearance resources are unavailable');
        }
        xobjects.set(imageKey, existingAppearance.imageRef);
        doc.context.assign(existingAppearance.imageRef, newImage);
        doc.context.assign(existingAppearance.appearanceRef, newAppearance);
        doc.context.delete(embeddedImage.ref);
        doc.context.delete(appearanceRef);
        liveAppearanceRef = existingAppearance.appearanceRef;
    }
    const stampDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: doc.context.obj([
            PDFNumber.of(x - rectOffsetX),
            PDFNumber.of(y - rectOffsetY),
            PDFNumber.of(x + width + rectOffsetX),
            PDFNumber.of(y + height + rectOffsetY),
        ]),
        AP: doc.context.obj({ N: liveAppearanceRef }),
        F: PDFNumber.of(4),
        NM: PDFHexString.fromText(placement.stableKey ?? `placed-image-${crypto.randomUUID()}`),
        Name: PDFName.of('Approved'),
    });
    if (existingRef) {
        doc.context.assign(existingRef, stampDict);
    } else {
        appendAnnotationRefToPage(page, doc, doc.context.register(stampDict));
    }
    return true;
}
