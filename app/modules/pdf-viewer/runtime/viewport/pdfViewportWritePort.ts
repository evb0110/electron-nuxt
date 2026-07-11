import {
    createDocumentViewportWritePort,
    type IDocumentViewportWrite,
    type IDocumentViewportWritePort,
} from '@app/utils/document-viewer/chassis/documentViewportWritePort';

export type IPdfViewportWrite = IDocumentViewportWrite;
export type IPdfViewportWritePort = IDocumentViewportWritePort;
export const createPdfViewportWritePort = createDocumentViewportWritePort;

export function applyPdfViewportWrite(
    port: IPdfViewportWritePort,
    container: HTMLElement,
    write: Omit<IPdfViewportWrite, 'intent'> & {intentId: string},
) {
    const {
        intentId,
        ...payload
    } = write;
    port.apply(container, {
        ...payload,
        intent: port.beginIntent(intentId),
    });
}
