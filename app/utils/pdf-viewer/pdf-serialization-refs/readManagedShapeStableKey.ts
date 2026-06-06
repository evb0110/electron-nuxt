import type {PDFDict} from 'pdf-lib';
import {PDFName} from 'pdf-lib';
import { getPdfStringValue } from '@app/utils/pdfDict';
import { normalizeManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/normalizeManagedShapeStableKey';

const MANAGED_SHAPE_KEY_NAME = PDFName.of('EVBShapeKey');

export function readManagedShapeStableKey(dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    return normalizeManagedShapeStableKey(getPdfStringValue(dict.get(MANAGED_SHAPE_KEY_NAME)));
}
