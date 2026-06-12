export interface IPdfAnnotationRef {
    objectNumber: number;
    generationNumber: number;
}

export function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(/^(\d+)R(?:(\d+))?$/i);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;
    if (
        !Number.isInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isInteger(generationNumber)
        || generationNumber < 0
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
