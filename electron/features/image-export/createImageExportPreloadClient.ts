import type { IpcRenderer } from 'electron';
import type {
    IImageExportCapability,
    IImageExportProgress,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import { isRecord } from '@contracts/runtimeGuards';
import {
    IMAGE_EXPORT_EVENT_CHANNELS,
    IMAGE_EXPORT_CHANNELS,
    type IImageExportEventMap,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/index';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function decodeImageExportProgress(payload: unknown): IImageExportProgress | null {
    if (
        !isRecord(payload)
        || typeof payload.requestId !== 'string'
        || (payload.format !== 'images' && payload.format !== 'multipage-tiff')
        || (payload.phase !== 'rendering' && payload.phase !== 'combining')
        || !isFiniteNumber(payload.processed)
        || !isFiniteNumber(payload.total)
        || !isFiniteNumber(payload.percent)
    ) {
        return null;
    }

    return {
        requestId: payload.requestId,
        format: payload.format,
        phase: payload.phase,
        processed: payload.processed,
        total: payload.total,
        percent: payload.percent,
    };
}

export function createImageExportPreloadClient(
    ipcRenderer: IpcRenderer,
): IImageExportCapability {
    const invoke = createTypedIpcInvoker<IImageExportInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IImageExportEventMap>(ipcRenderer);

    return {
        exportPdfToImages: (
            workingPath: TDocumentRef,
            pageNumbers?: number[],
            requestId?: string,
        ) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportImages, workingPath, pageNumbers, requestId),
        exportPdfToMultiPageTiff: (
            workingPath: TDocumentRef,
            pageNumbers?: number[],
            requestId?: string,
        ) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff, workingPath, pageNumbers, requestId),
        onProgress: (callback: (progress: IImageExportProgress) => void): (() => void) =>
            eventSubscriber.onDecodedPayload(IMAGE_EXPORT_EVENT_CHANNELS.progress, decodeImageExportProgress, callback),
    };
}
