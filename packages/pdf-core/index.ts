export {
    buildPdfSaveRestrictions,
    createConservativePdfConformanceFallbackProfile,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@pdf-core/pdfConformanceHelpers';
export { loadPdfStructure } from '@pdf-core/loadPdfStructure';
export type {
    IPdfPageBox,
    TPdfRect,
} from '@pdf-core/pdfPageBoxes';
export {
    arePdfPageBoxesEqual,
    fromPdfRect,
    intersectPdfPageBoxes,
    normalizePdfPageBox,
    numberFromPdfBox,
    readPdfRectFromDict,
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
    resolvePdfLibPageView,
    toPdfRect,
    tryResolvePdfLibPageView,
} from '@pdf-core/pdfPageBoxes';
export {
    isPdfUnexpectedObjectTypeError,
    safePdfContextLookupArray,
    safePdfContextLookupDict,
    safePdfContextLookupStream,
    safePdfDictLookupArray,
    safePdfDictLookupDict,
    safePdfDictLookupName,
    safePdfDictLookupNumber,
    safePdfPageAnnots,
    safePdfPageInheritableDict,
} from '@pdf-core/safePdfLookup';
export { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';
export { iterateDecodedTiffFrames } from '@pdf-core/iterateDecodedTiffFrames';
export {
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
} from '@pdf-core/pdfjsTextGeometry';
export type {
    IPdfjsOperatorListLike,
    IPdfjsPageViewBox,
    TPdfjsTextOps,
} from '@pdf-core/pdfjsTextGeometry';
export { collectSearchMatchWords } from '@pdf-core/collectSearchMatchWords';
export {
    buildTiffImageIfd,
    encodeTiffIfds,
    getTiffValueCount,
    measureTiffIfdSize,
} from '@pdf-core/tiffEncoding';
export type { ITiffImageDescriptor } from '@pdf-core/tiffEncoding';
