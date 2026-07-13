import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentSourceCapabilities } from '@app/utils/document-viewer/source/documentPageSource';

type TDocumentSessionSourceKind = 'pdf' | 'djvu' | null;

export interface IDocumentSourceActivation {
    generation: number;
    kind: Exclude<TDocumentSessionSourceKind, null>;
    documentRef: TDocumentRef;
}

const DJVU_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: true,
    outline: false,
    pageEdits: false,
    search: false,
    text: false,
};

const EMPTY_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: false,
    outline: false,
    pageEdits: false,
    search: false,
    text: false,
};

/** Source identity owned by the document session rather than a format mode flag. */
export const useDocumentSourceSession = () => {
    const sourceKind = ref<TDocumentSessionSourceKind>(null);
    const sourceRef = ref<TDocumentRef | null>(null);
    const projectionRef = ref<TDocumentRef | null>(null);
    const sourceGeneration = ref(0);
    let activeActivation: IDocumentSourceActivation | null = null;
    const capabilities = computed<IDocumentSourceCapabilities>(() => (
        sourceKind.value === 'djvu' ? DJVU_SOURCE_CAPABILITIES : EMPTY_SOURCE_CAPABILITIES
    ));

    function activateDocumentSource(
        kind: Exclude<TDocumentSessionSourceKind, null>,
        documentRef: TDocumentRef,
        pdfProjectionRef: TDocumentRef | null = null,
    ) {
        const activation: IDocumentSourceActivation = {
            generation: sourceGeneration.value + 1,
            kind,
            documentRef,
        };
        sourceGeneration.value = activation.generation;
        activeActivation = activation;
        sourceKind.value = kind;
        sourceRef.value = documentRef;
        projectionRef.value = pdfProjectionRef;
        return activation;
    }

    function captureDocumentSourceActivation(): IDocumentSourceActivation | null {
        return activeActivation ? {...activeActivation} : null;
    }

    function clearDocumentSource(expectedActivation?: IDocumentSourceActivation) {
        if (
            expectedActivation
            && (
                activeActivation?.generation !== expectedActivation.generation
                || activeActivation.kind !== expectedActivation.kind
                || activeActivation.documentRef !== expectedActivation.documentRef
            )
        ) {
            return false;
        }
        sourceGeneration.value += 1;
        activeActivation = null;
        sourceKind.value = null;
        sourceRef.value = null;
        projectionRef.value = null;
        return true;
    }

    return {
        sourceKind,
        sourceRef,
        projectionRef,
        sourceGeneration,
        capabilities,
        isDjvuSource: computed(() => sourceKind.value === 'djvu'),
        activateDocumentSource,
        captureDocumentSourceActivation,
        clearDocumentSource,
    };
};
