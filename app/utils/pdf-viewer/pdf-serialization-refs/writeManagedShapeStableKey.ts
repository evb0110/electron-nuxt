import type {PDFDict} from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
} from 'pdf-lib';
import { normalizeManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/normalizeManagedShapeStableKey';
import { readManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/readManagedShapeStableKey';

const MANAGED_SHAPE_KEY_NAME = PDFName.of('EVBShapeKey');

export function writeManagedShapeStableKey(dict: PDFDict, stableKey: string | null | undefined) {
    const normalizedStableKey = normalizeManagedShapeStableKey(stableKey);
    if (!normalizedStableKey) {
        return false;
    }

    const currentStableKey = readManagedShapeStableKey(dict);
    if (currentStableKey === normalizedStableKey) {
        return false;
    }

    dict.set(MANAGED_SHAPE_KEY_NAME, PDFHexString.fromText(normalizedStableKey));
    return true;
}
