import {
    getOcrToolPaths,
    type IOcrToolPaths,
} from '@electron/ocr/paths';

export function getNativeToolPaths(): IOcrToolPaths {
    return getOcrToolPaths();
}
