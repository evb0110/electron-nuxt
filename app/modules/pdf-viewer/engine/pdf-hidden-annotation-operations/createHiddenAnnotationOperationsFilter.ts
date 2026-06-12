import type { PDFPageProxy } from 'pdfjs-dist';
import type { PDFOperatorList } from 'pdfjs-dist/types/src/display/api';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IHiddenAnnotationScanState {
    skippedIndices: Set<number>;
    annotationStack: boolean[];
    hiddenDepth: number;
}

const BEGIN_ANNOTATION_OP = 80;

const END_ANNOTATION_OP = 81;

function normalizeAnnotationIdSet(annotationIds: Set<string>) {
    const normalizedIds = new Set<string>();
    annotationIds.forEach((id) => {
        const normalizedId = normalizePdfJsAnnotationId(id);
        if (normalizedId) {
            normalizedIds.add(normalizedId);
        }
    });
    return normalizedIds;
}

function processBeginAnnotationOperator(
    state: IHiddenAnnotationScanState,
    args: unknown,
    index: number,
    hiddenAnnotationIds: Set<string>,
) {
    const annotationId = Array.isArray(args) && typeof args[0] === 'string'
        ? normalizePdfJsAnnotationId(args[0])
        : null;
    const isHidden = annotationId ? hiddenAnnotationIds.has(annotationId) : false;

    if (state.hiddenDepth > 0 || isHidden) {
        state.skippedIndices.add(index);
    }

    state.annotationStack.push(isHidden);
    if (isHidden) {
        state.hiddenDepth += 1;
    }
}

function processEndAnnotationOperator(state: IHiddenAnnotationScanState) {
    const didHideCurrentAnnotation = state.annotationStack.pop() ?? false;
    if (didHideCurrentAnnotation) {
        state.hiddenDepth = Math.max(0, state.hiddenDepth - 1);
    }
}

function collectHiddenAnnotationOperatorIndices(
    operatorList: PDFOperatorList,
    hiddenAnnotationIds: Set<string>,
) {
    if (hiddenAnnotationIds.size === 0) {
        return new Set<number>();
    }

    const state: IHiddenAnnotationScanState = {
        skippedIndices: new Set<number>(),
        annotationStack: [],
        hiddenDepth: 0,
    };

    for (const [
        index,
        fn,
    ] of operatorList.fnArray.entries()) {
        if (fn === BEGIN_ANNOTATION_OP) {
            processBeginAnnotationOperator(
                state,
                operatorList.argsArray[index],
                index,
                hiddenAnnotationIds,
            );
            continue;
        }

        if (state.hiddenDepth > 0) {
            state.skippedIndices.add(index);
        }

        if (fn === END_ANNOTATION_OP) {
            processEndAnnotationOperator(state);
        }
    }

    return state.skippedIndices;
}

export async function createHiddenAnnotationOperationsFilter(
    pdfPage: PDFPageProxy,
    annotationMode: number,
    hiddenAnnotationIds?: Set<string>,
) {
    if (!hiddenAnnotationIds || hiddenAnnotationIds.size === 0) {
        return undefined;
    }

    if (typeof pdfPage.getOperatorList !== 'function') {
        return undefined;
    }

    try {
        const normalizedHiddenAnnotationIds = normalizeAnnotationIdSet(hiddenAnnotationIds);
        if (normalizedHiddenAnnotationIds.size === 0) {
            return undefined;
        }

        const operatorList = await pdfPage.getOperatorList({ annotationMode });
        const skippedIndices = collectHiddenAnnotationOperatorIndices(
            operatorList,
            normalizedHiddenAnnotationIds,
        );

        if (skippedIndices.size === 0) {
            return undefined;
        }

        return (index: number) => !skippedIndices.has(index);
    } catch (error) {
        BrowserLogger.warn(
            'pdf-renderer',
            `Failed to build hidden annotation filter for page ${pdfPage.pageNumber}`,
            error,
        );
        return undefined;
    }
}
