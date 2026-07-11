import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentSourceCapabilities } from '@app/utils/document-viewer/source/documentPageSource';

type TDocumentSessionSourceKind = 'pdf' | 'djvu' | null;

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
    const capabilities = computed<IDocumentSourceCapabilities>(() => (
        sourceKind.value === 'djvu' ? DJVU_SOURCE_CAPABILITIES : EMPTY_SOURCE_CAPABILITIES
    ));

    function activateDocumentSource(
        kind: Exclude<TDocumentSessionSourceKind, null>,
        documentRef: TDocumentRef,
        pdfProjectionRef: TDocumentRef | null = null,
    ) {
        sourceKind.value = kind;
        sourceRef.value = documentRef;
        projectionRef.value = pdfProjectionRef;
    }

    function clearDocumentSource() {
        sourceKind.value = null;
        sourceRef.value = null;
        projectionRef.value = null;
    }

    return {
        sourceKind,
        sourceRef,
        projectionRef,
        capabilities,
        isDjvuSource: computed(() => sourceKind.value === 'djvu'),
        activateDocumentSource,
        clearDocumentSource,
    };
};
