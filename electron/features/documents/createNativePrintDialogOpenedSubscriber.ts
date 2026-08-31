import type {IpcRenderer} from 'electron';
import type {IDocumentsFileCapability} from '@contracts/electronApiDocuments';
import {DOCUMENT_PDF_PLATFORM_FEATURE} from '@contracts/documentsPlatformFeature';
import {decodePdfNativePrintDialogOpenedEvent} from '@contracts/pdfPathPrintOptions';
import {createTypedIpcEventSubscriber} from '@electron/preload/ipcClient';

interface INativePrintDialogEventMap { [DOCUMENT_PDF_PLATFORM_FEATURE.eventChannels.onNativePrintDialogOpened]: {requestId: string}; }

type TSubscribeToNativePrintDialogOpened = NonNullable<
    IDocumentsFileCapability['onNativePrintDialogOpened']
>;

function decodePreloadNativePrintDialogOpenedEvent(value: unknown) {
    try {
        return decodePdfNativePrintDialogOpenedEvent(value);
    } catch {
        return null;
    }
}

export function createNativePrintDialogOpenedSubscriber(
    ipcRenderer: Partial<Pick<IpcRenderer, 'on' | 'removeListener'>>,
): TSubscribeToNativePrintDialogOpened {
    const eventSubscriber = createTypedIpcEventSubscriber<INativePrintDialogEventMap>(ipcRenderer);
    return callback => eventSubscriber.onDecodedPayload(
        DOCUMENT_PDF_PLATFORM_FEATURE.eventChannels.onNativePrintDialogOpened,
        decodePreloadNativePrintDialogOpenedEvent,
        callback,
    );
}
