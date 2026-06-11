import type {PDFDict} from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
} from 'pdf-lib';
import { getPdfStringValue } from '@app/utils/pdfDict';
import { normalizeManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/normalizeManagedShapeStableKey';

const MANAGED_SHAPE_KEY_NAME = PDFName.of('EVBShapeKey');
const ANNOTATION_NAME = PDFName.of('NM');

export function writeManagedShapeStableKey(dict: PDFDict, stableKey: string | null | undefined) {
    const normalizedStableKey = normalizeManagedShapeStableKey(stableKey);
    if (!normalizedStableKey) {
        return false;
    }

    const currentStableKey = normalizeManagedShapeStableKey(getPdfStringValue(dict.get(MANAGED_SHAPE_KEY_NAME)));
    let modified = false;
    if (currentStableKey !== normalizedStableKey) {
        dict.set(MANAGED_SHAPE_KEY_NAME, PDFHexString.fromText(normalizedStableKey));
        modified = true;
    }

    if (getPdfStringValue(dict.get(ANNOTATION_NAME)) !== normalizedStableKey) {
        dict.set(ANNOTATION_NAME, PDFHexString.fromText(normalizedStableKey));
        modified = true;
    }

    return modified;
}
