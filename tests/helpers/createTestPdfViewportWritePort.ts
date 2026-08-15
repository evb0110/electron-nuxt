import type {
    IPdfViewportWrite,
    IPdfViewportWritePort,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

export function createTestPdfViewportWritePort() {
    const writes: IPdfViewportWrite[] = [];
    let revision = 0;
    let sequence = 0;
    const port: IPdfViewportWritePort = {
        beginIntent(intentId) {
            return {
                intentId,
                documentRevision: revision,
                interactionEpoch: 0,
                sequence: ++sequence,
            };
        },
        apply(container, write) {
            writes.push(write);
            if (write.left !== undefined) container.scrollLeft = write.left;
            if (write.top !== undefined) container.scrollTop = write.top;
            return true;
        },
        advanceDocumentRevision: () => ++revision,
        assertNoRogueWrite: () => {},
        consumeAuthorityScroll: () => false,
        getInteractionEpoch: () => 0,
        observeUserInteraction: () => {},
        observeUserScroll: () => {},
    };
    return {
        port,
        writes,
    };
}
