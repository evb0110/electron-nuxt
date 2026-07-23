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
import { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
import {OCR_CHANNELS} from '@electron/features/ocr/contract';
import { OCR_IPC_CODECS } from '@electron/features/ocr/ocrIpcCodecs';
import {SCAN_CLEANUP_CHANNELS} from '@electron/features/scan-cleanup/contract';
import {SCAN_CLEANUP_IPC_CODECS} from '@electron/features/scan-cleanup/scanCleanupIpcCodecs';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
import { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';
import { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { HOST_PLATFORM_FEATURE } from '@contracts/hostPlatformFeature';
import type { TAnyDefinedPlatformFeature } from '@contracts/platformFeature';
import {DJVU_CHANNELS} from '@electron/features/djvu/contract';
import { DJVU_IPC_CODECS } from '@electron/features/djvu/djvuIpcCodecs';
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

function registerLazyPlatformFeature(
    ipcMain: Electron.IpcMain,
    feature: TAnyDefinedPlatformFeature,
    loadBindings: () => Promise<Record<string, unknown>>,
) {
    registerLazyValidatedFeature(
        ipcMain,
        feature.invokeChannels,
        feature.ipcCodecs,
        async (registrar) => registerPlatformFeatureHandlers(
            registrar as never,
            feature as never,
            await loadBindings() as never,
        ),
    );
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
    registerLazyPlatformFeature(ipcMain, SETTINGS_PLATFORM_FEATURE, async () => {
        const {createSettingsMainBindings} =
            await import('@electron/features/settings/createSettingsMainBindings');
        return createSettingsMainBindings(options.agentService.shutdownAssistant);
    });
    registerLazyPlatformFeature(ipcMain, SHELL_PLATFORM_FEATURE, async () => {
        const {shellMainBindings} = await import('@electron/features/shell/shellMainBindings');
        return shellMainBindings;
    });
    registerLazyPlatformFeature(ipcMain, UPDATES_PLATFORM_FEATURE, () => import('@electron/updates'));
    registerLazyPlatformFeature(ipcMain, HOST_PLATFORM_FEATURE, async () => {
        const {hostMainBindings} = await import('@electron/hostEnvironment');
        return hostMainBindings;
    });
    registerLazyPlatformFeature(ipcMain, IMAGE_EXPORT_PLATFORM_FEATURE, async () => {
        const {imageExportMainBindings} = await import('@electron/features/image-export/public');
        return imageExportMainBindings;
    });
    registerLazyPlatformFeature(ipcMain, PAGE_OPS_PLATFORM_FEATURE, async () => {
        const {pageOpsMainBindings} = await import('@electron/features/page-ops/public');
        return pageOpsMainBindings;
    });
    registerLazyValidatedFeature(ipcMain, OCR_CHANNELS, OCR_IPC_CODECS, async registrar => {
        const {registerOcrIpcAdapter} = await import('@electron/features/ocr/registerOcrIpcAdapter');
        registerOcrIpcAdapter(registrar as never);
    });
    registerLazyValidatedFeature(ipcMain, SCAN_CLEANUP_CHANNELS, SCAN_CLEANUP_IPC_CODECS, async registrar => {
        const {registerScanCleanupIpcAdapter} = await import('@electron/features/scan-cleanup/registerScanCleanupIpcAdapter');
        registerScanCleanupIpcAdapter(registrar as never);
    });
    registerLazyPlatformFeature(ipcMain, SEARCH_PLATFORM_FEATURE, async () => {
        const {prepareSearchMainBindings} = await import('@electron/features/search/public');
        return prepareSearchMainBindings();
    });
    registerLazyValidatedFeature(ipcMain, DJVU_CHANNELS, DJVU_IPC_CODECS, async registrar => {
        const {registerDjvuIpcAdapter} = await import('@electron/features/djvu/registerDjvuIpcAdapter');
        registerDjvuIpcAdapter(registrar as never);
    });
}
