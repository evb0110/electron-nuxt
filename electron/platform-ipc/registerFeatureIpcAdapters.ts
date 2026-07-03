import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    registerDocumentRevisionEventBridge,
    registerDocumentRevisionInvalidationEffects,
} from '@electron/features/documents/public';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { registerAgentIpcAdapter } from '@electron/features/agent/registerAgentIpcAdapter';
import {
    AGENT_CHANNELS,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import type { IAgentService } from '@electron/features/agent/ports';
import { registerImageExportIpcAdapter } from '@electron/features/image-export/registerImageExportIpcAdapter';
import {
    IMAGE_EXPORT_CHANNELS,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/contract';
import { registerOcrIpcAdapter } from '@electron/features/ocr/registerOcrIpcAdapter';
import {
    OCR_CHANNELS,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import { registerSearchIpcAdapter } from '@electron/features/search/registerSearchIpcAdapter';
import {
    SEARCH_CHANNELS,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import { registerDjvuIpcAdapter } from '@electron/features/djvu/registerDjvuIpcAdapter';
import {
    DJVU_CHANNELS,
    type IDjvuInvokeMap,
} from '@electron/features/djvu/contract';
import { registerPageOpsIpcAdapter } from '@electron/features/page-ops/registerPageOpsIpcAdapter';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/contract';
import {
    createChannelSet,
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';

const DOCUMENTS_CHANNEL_SET = createChannelSet(DOCUMENTS_CHANNELS);

export interface IFeatureIpcAdapterOptions { agentService: IAgentService; }

export function registerFeatureIpcAdapters(
    ipcMain: Electron.IpcMain,
    options: IFeatureIpcAdapterOptions,
) {
    registerDocumentsIpcAdapter(
        createValidatedIpcMainRegistrar<IDocumentsInvokeMap>(ipcMain, {allowedChannels: DOCUMENTS_CHANNEL_SET}),
        undefined,
        {eventRegistrar: createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: DOCUMENTS_CHANNEL_SET})},
    );
    registerDocumentRevisionEventBridge();
    registerDocumentRevisionInvalidationEffects();
    registerAgentIpcAdapter(
        createValidatedIpcMainRegistrar<IAgentInvokeMap>(ipcMain, {allowedChannels: createChannelSet(AGENT_CHANNELS)}),
        options.agentService,
    );
    registerImageExportIpcAdapter(createValidatedIpcMainRegistrar<IImageExportInvokeMap>(ipcMain, {allowedChannels: createChannelSet(IMAGE_EXPORT_CHANNELS)}));
    registerPageOpsIpcAdapter(createValidatedIpcMainRegistrar<IPageOpsInvokeMap>(ipcMain, {allowedChannels: createChannelSet(PAGE_OPS_CHANNELS)}));
    registerOcrIpcAdapter(createValidatedIpcMainRegistrar<IOcrInvokeMap>(ipcMain, {allowedChannels: createChannelSet(OCR_CHANNELS)}));
    registerSearchIpcAdapter(createValidatedIpcMainRegistrar<ISearchInvokeMap>(ipcMain, {allowedChannels: createChannelSet(SEARCH_CHANNELS)}));
    registerDjvuIpcAdapter(createValidatedIpcMainRegistrar<IDjvuInvokeMap>(ipcMain, {allowedChannels: createChannelSet(DJVU_CHANNELS)}));
}
