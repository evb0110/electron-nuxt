export interface IPdfAnnotationRef {
    objectNumber: number;
    generationNumber: number;
}

const PDF_JS_ANNOTATION_REF_PATTERN = /^(\d+)R(?:(\d+))?$/iu;

/** Parse the compact PDF.js annotation reference form, such as `42R0`. */
export function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(PDF_JS_ANNOTATION_REF_PATTERN);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;
    if (
        !Number.isSafeInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isSafeInteger(generationNumber)
        || generationNumber < 0
        || generationNumber > 65_535
    ) {
        return null;
    }

    return {
        objectNumber,
        generationNumber,
    };
}

export function formatPdfJsAnnotationRef(
    ref: IPdfAnnotationRef,
) {
    return ref.generationNumber === 0
        ? `${ref.objectNumber}R`
        : `${ref.objectNumber}R${ref.generationNumber}`;
}

export function normalizePdfJsAnnotationId(annotationId: string | null | undefined) {
    const ref = parsePdfJsAnnotationRef(annotationId);
    if (ref) {
        return formatPdfJsAnnotationRef(ref);
    }

    const trimmed = annotationId?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}
