import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import {
    OCR_CHANNELS,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import {createOcrService} from '@electron/features/ocr/createOcrService';
import type {
    IOcrOperationContext,
    IOcrService,
} from '@electron/features/ocr/ports';

export type TOcrIpcMainRegistrar = IContractIpcMainRegistrar<IOcrInvokeMap, IpcMainInvokeEvent>;

function createOcrOperationContext(event: IpcMainInvokeEvent): IOcrOperationContext {
    return {
        sender: event.sender,
        senderId: event.sender.id,
        parentWindow: BrowserWindow.fromWebContents(event.sender),
    };
}

export function registerOcrIpcAdapter(
    registrar: TOcrIpcMainRegistrar = ipcMain,
    service: IOcrService = createOcrService(),
) {
    registrar.handle(OCR_CHANNELS.recognize, (event, request) =>
        service.recognize(createOcrOperationContext(event), request));
    registrar.handle(OCR_CHANNELS.recognizeBatch, (event, pages, requestId) =>
        service.recognizeBatch(createOcrOperationContext(event), pages, requestId));
    registrar.handle(OCR_CHANNELS.createSearchablePdf, (event, sourcePdfPath, pages, requestId, renderDpiOrOptions) =>
        service.createSearchablePdf(createOcrOperationContext(event), sourcePdfPath, pages, requestId, renderDpiOrOptions));
    registrar.handle(OCR_CHANNELS.cancel, (event, requestId) =>
        service.cancel(createOcrOperationContext(event), requestId));
    registrar.handle(OCR_CHANNELS.getJobState, (event, requestId) =>
        service.getJobState(createOcrOperationContext(event), requestId));
    registrar.handle(OCR_CHANNELS.subscribeJob, (event, requestId) =>
        service.subscribeJob(createOcrOperationContext(event), requestId));
    registrar.handle(OCR_CHANNELS.reconnectJob, (event, requestId) =>
        service.reconnectJob(createOcrOperationContext(event), requestId));
    registrar.handle(OCR_CHANNELS.acknowledgeResultFile, (event, requestId, pdfPath) =>
        service.acknowledgeResultFile(createOcrOperationContext(event), requestId, pdfPath));
    registrar.handle(OCR_CHANNELS.getLanguages, (event) =>
        service.getLanguages(createOcrOperationContext(event)));
    registrar.handle(OCR_CHANNELS.resolveDocumentTextCatalog, (event, workingCopyPath, documentRevision, pageCount) =>
        service.resolveDocumentTextCatalog(
            createOcrOperationContext(event),
            workingCopyPath,
            documentRevision,
            pageCount,
        ));
    registrar.handle(OCR_CHANNELS.validateTools, (event) =>
        service.validateTools(createOcrOperationContext(event)));
    registrar.handle(OCR_CHANNELS.preprocessingValidate, (event) =>
        service.preprocessingValidate(createOcrOperationContext(event)));
    registrar.handle(OCR_CHANNELS.preprocessingPreprocessPage, (event, imageData, usePreprocessing) =>
        service.preprocessPage(createOcrOperationContext(event), imageData, usePreprocessing));
    registrar.handle(OCR_CHANNELS.subscribeProgress, (event) => {
        service.subscribeProgress(createOcrOperationContext(event));
        return undefined;
    });
}
