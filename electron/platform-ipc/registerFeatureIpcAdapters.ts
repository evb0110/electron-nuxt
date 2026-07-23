import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    registerDocumentRevisionEventBridge,
    registerDocumentRevisionInvalidationEffects,
} from '@electron/features/documents/public';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import {AGENT_CHANNELS} from '@electron/features/agent/contract';
import { AGENT_IPC_CODECS } from '@electron/features/agent/agentIpcCodecs';
import type { IAgentService } from '@electron/features/agent/ports';
import {IMAGE_EXPORT_CHANNELS} from '@electron/features/image-export/contract';
import { IMAGE_EXPORT_IPC_CODECS } from '@electron/features/image-export/imageExportIpcCodecs';
import {OCR_CHANNELS} from '@electron/features/ocr/contract';
import { OCR_IPC_CODECS } from '@electron/features/ocr/ocrIpcCodecs';
import {SCAN_CLEANUP_CHANNELS} from '@electron/features/scan-cleanup/contract';
import {SCAN_CLEANUP_IPC_CODECS} from '@electron/features/scan-cleanup/scanCleanupIpcCodecs';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import {DJVU_CHANNELS} from '@electron/features/djvu/contract';
import { DJVU_IPC_CODECS } from '@electron/features/djvu/djvuIpcCodecs';
import { PAGE_OPS_IPC_CODECS } from '@electron/features/page-ops/pageOpsIpcCodecs';
import {PAGE_OPS_CHANNELS} from '@electron/features/page-ops/contract';
import {
    createChannelSet,
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
    registerPlatformFeatureHandlers,
} from '@electron/platform-ipc/validatedIpcRegistrar';

const DOCUMENTS_CHANNEL_SET = createChannelSet(DOCUMENTS_CHANNELS);

type TDeferredHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown;

function registerLazyValidatedFeature(
    ipcMain: Electron.IpcMain,
    channels: Record<string, string>,
    codecs: Record<string, {
        decodeArgs: (args: readonly unknown[]) => unknown[];
        decodeResult: (value: unknown) => unknown;
    }>,
    load: (registrar: {handle: (channel: string, handler: TDeferredHandler) => void;}) => Promise<void>,
) {
    const handlers = new Map<string, TDeferredHandler>();
    let loading: Promise<void> | null = null;
    const ensureLoaded = async () => {
        loading ??= load({handle: (channel, handler) => {
            if (handlers.has(channel)) throw new Error(`Duplicate lazy IPC handler: ${channel}`);
            handlers.set(channel, handler);
        }});
        await loading;
    };
    const registrar = createValidatedIpcMainRegistrar(ipcMain, {
        allowedChannels: createChannelSet(channels),
        codecs: codecs as never,
    });
    for (const channel of Object.values(channels)) {
        registrar.handle(channel, async (event, ...args: unknown[]) => {
            await ensureLoaded();
            const handler = handlers.get(channel);
            if (!handler) throw new Error(`Lazy IPC feature did not register channel: ${channel}`);
            return handler(event, ...args as never[]);
        });
    }
}

export interface IFeatureIpcAdapterOptions { agentService: IAgentService; }

export function registerFeatureIpcAdapters(
    ipcMain: Electron.IpcMain,
    options: IFeatureIpcAdapterOptions,
) {
    registerDocumentsIpcAdapter(
        createValidatedIpcMainRegistrar<IDocumentsInvokeMap>(ipcMain, {
            allowedChannels: DOCUMENTS_CHANNEL_SET,
            codecs: DOCUMENTS_IPC_CODECS,
        }),
        undefined,
        {eventRegistrar: createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: DOCUMENTS_CHANNEL_SET})},
    );
    registerDocumentRevisionEventBridge();
    registerDocumentRevisionInvalidationEffects();
    registerLazyValidatedFeature(ipcMain, AGENT_CHANNELS, AGENT_IPC_CODECS, async registrar => {
        const {registerAgentIpcAdapter} = await import('@electron/features/agent/registerAgentIpcAdapter');
        registerAgentIpcAdapter(registrar as never, options.agentService);
    });
    registerLazyValidatedFeature(ipcMain, IMAGE_EXPORT_CHANNELS, IMAGE_EXPORT_IPC_CODECS, async registrar => {
        const {registerImageExportIpcAdapter} = await import('@electron/features/image-export/registerImageExportIpcAdapter');
        registerImageExportIpcAdapter(registrar as never);
    });
    registerLazyValidatedFeature(ipcMain, PAGE_OPS_CHANNELS, PAGE_OPS_IPC_CODECS, async registrar => {
        const {registerPageOpsIpcAdapter} = await import('@electron/features/page-ops/registerPageOpsIpcAdapter');
        registerPageOpsIpcAdapter(registrar as never);
    });
    registerLazyValidatedFeature(ipcMain, OCR_CHANNELS, OCR_IPC_CODECS, async registrar => {
        const {registerOcrIpcAdapter} = await import('@electron/features/ocr/registerOcrIpcAdapter');
        registerOcrIpcAdapter(registrar as never);
    });
    registerLazyValidatedFeature(ipcMain, SCAN_CLEANUP_CHANNELS, SCAN_CLEANUP_IPC_CODECS, async registrar => {
        const {registerScanCleanupIpcAdapter} = await import('@electron/features/scan-cleanup/registerScanCleanupIpcAdapter');
        registerScanCleanupIpcAdapter(registrar as never);
    });
    registerLazyValidatedFeature(
        ipcMain,
        SEARCH_PLATFORM_FEATURE.invokeChannels,
        SEARCH_PLATFORM_FEATURE.ipcCodecs,
        async (registrar) => {
            const {prepareSearchMainBindings} = await import('@electron/features/search/public');
            registerPlatformFeatureHandlers(
                registrar as never,
                SEARCH_PLATFORM_FEATURE,
                prepareSearchMainBindings(),
            );
        },
    );
    registerLazyValidatedFeature(ipcMain, DJVU_CHANNELS, DJVU_IPC_CODECS, async registrar => {
        const {registerDjvuIpcAdapter} = await import('@electron/features/djvu/registerDjvuIpcAdapter');
        registerDjvuIpcAdapter(registrar as never);
    });
}
