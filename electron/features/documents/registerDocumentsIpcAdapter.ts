import type {
    IpcMainEvent,
    IpcMainInvokeEvent,
} from 'electron';
import { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import type { Entries } from 'type-fest';
import type {
    IIpcMainRegistrar,
    TIpcMainInvokeHandler,
} from '@contracts/ipcMain';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENTS_SIMPLE_PLATFORM_FEATURES,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createDocumentsService} from '@electron/features/documents/createDocumentsService';
import type {
    IDocumentsDialogContext,
    IDocumentsSenderIdContext,
    IDocumentsService,
    IDocumentsWebContentsContext,
    IDocumentsWindowContext,
} from '@electron/features/documents/documentsService';
import { attachSerializedPdfPersistencePort } from '@electron/features/documents/public';
import {
    allowOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import { requireManagedWorkingCopyPath } from '@electron/file-access/workingCopyCreation';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';

interface IRendererFileOpenToken {expiresAtMs: number;}
interface IDocumentsIpcEventRegistrar {on: (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void) => void;}
interface IRegisterDocumentsIpcAdapterOptions {eventRegistrar?: IDocumentsIpcEventRegistrar;}
type TDocumentsIpcRegistrar = IIpcMainRegistrar<IDocumentsInvokeMap, IpcMainInvokeEvent>;
type TDocumentsIpcChannel = Extract<keyof IDocumentsInvokeMap, string>;
type TDocumentsIpcArgs<TChannel extends TDocumentsIpcChannel> = IDocumentsInvokeMap[TChannel]['args'];

export const DOCUMENTS_IPC_CHANNEL_ALIASES = [
    {
        aliasKey: 'openPdfDirect',
        ownerKey: 'openDocumentDirect',
    },
    {
        aliasKey: 'openPdfDirectBatch',
        ownerKey: 'openDocumentDirectBatch',
    },
] as const satisfies ReadonlyArray<{
    aliasKey: keyof typeof DOCUMENTS_CHANNELS;
    ownerKey: keyof typeof DOCUMENTS_CHANNELS;
}>;

const RENDERER_FILE_OPEN_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER = 128;
const RENDERER_FILE_OPEN_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const logger = createLogger('documents-ipc-adapter');
const rendererFileOpenTokens = new Map<number, Map<string, IRendererFileOpenToken>>();
const rendererFileOpenTokenCleanupSenders = new Set<number>();

function getDistinctDocumentsChannelValues() {
    return [...new Set<string>([
        ...Object.values(DOCUMENTS_CHANNELS),
        ...DOCUMENTS_SIMPLE_PLATFORM_FEATURES.flatMap(feature =>
            [...feature.invokeChannelSet]),
    ])];
}

function assertDocumentsIpcChannelAliasesAreExplicit() {
    const aliasByKey = new Map<keyof typeof DOCUMENTS_CHANNELS, keyof typeof DOCUMENTS_CHANNELS>(
        DOCUMENTS_IPC_CHANNEL_ALIASES.map(alias => [
            alias.aliasKey,
            alias.ownerKey,
        ]),
    );
    const keysByChannel = new Map<string, Array<keyof typeof DOCUMENTS_CHANNELS>>();
    for (const [
        key,
        channel,
    ] of Object.entries(DOCUMENTS_CHANNELS) as Entries<typeof DOCUMENTS_CHANNELS>) {
        const keys = keysByChannel.get(channel) ?? [];
        keys.push(key);
        keysByChannel.set(channel, keys);
    }

    for (const {
        aliasKey,
        ownerKey,
    } of DOCUMENTS_IPC_CHANNEL_ALIASES) {
        if (DOCUMENTS_CHANNELS[aliasKey] !== DOCUMENTS_CHANNELS[ownerKey]) {
            throw new Error(`Documents IPC alias ${String(aliasKey)} does not share ${String(ownerKey)} channel value`);
        }
    }

    for (const keys of keysByChannel.values()) {
        if (keys.length <= 1) {
            continue;
        }

        const firstKey = keys[0];
        if (!firstKey) {
            continue;
        }
        const explicitAliasCount = keys.filter(key => aliasByKey.has(key)).length;
        if (explicitAliasCount !== keys.length - 1) {
            throw new Error(`Documents IPC channel aliases must be explicit for channel value ${DOCUMENTS_CHANNELS[firstKey]}`);
        }
        for (const key of keys) {
            const ownerKey = aliasByKey.get(key);
            if (ownerKey && !keys.includes(ownerKey)) {
                throw new Error(`Documents IPC alias ${String(key)} points outside its channel group`);
            }
        }
    }
}

export function assertDocumentsIpcSingleRegistrationInvariant(registrations: readonly string[]) {
    assertDocumentsIpcChannelAliasesAreExplicit();

    const expectedChannels = getDistinctDocumentsChannelValues();
    const expectedChannelSet = new Set(expectedChannels);
    const registrationCounts = new Map<string, number>();
    for (const channel of registrations) {
        registrationCounts.set(channel, (registrationCounts.get(channel) ?? 0) + 1);
    }

    const unexpectedChannels = [...registrationCounts.keys()].filter(channel => !expectedChannelSet.has(channel));
    if (unexpectedChannels.length > 0) {
        throw new Error(`Unexpected documents IPC channel registration: ${unexpectedChannels.join(', ')}`);
    }

    const duplicateChannels = [...registrationCounts.entries()]
        .filter(([
            ,
            count,
        ]) => count > 1)
        .map(([channel]) => channel);
    if (duplicateChannels.length > 0) {
        throw new Error(`Duplicate documents IPC channel registration: ${duplicateChannels.join(', ')}`);
    }

    const missingChannels = expectedChannels.filter(channel => !registrationCounts.has(channel));
    if (missingChannels.length > 0) {
        throw new Error(`Missing documents IPC channel registration: ${missingChannels.join(', ')}`);
    }
}

function getSenderId(event: IpcMainInvokeEvent) {
    return event.sender.id;
}

function createWebContentsContext(event: IpcMainInvokeEvent): IDocumentsWebContentsContext {
    return {
        sender: event.sender,
        senderId: getSenderId(event),
    };
}

function createSenderIdContext(event: IpcMainInvokeEvent): IDocumentsSenderIdContext {
    return {
        sender: event.sender,
        senderId: getSenderId(event),
    };
}

function createDialogContext(event: IpcMainInvokeEvent): IDocumentsDialogContext {
    return {
        ...createWebContentsContext(event),
        parentWindow: BrowserWindow.fromWebContents(event.sender),
    };
}

function createWindowContext(event: IpcMainInvokeEvent): IDocumentsWindowContext {
    return {
        senderId: getSenderId(event),
        window: BrowserWindow.fromWebContents(event.sender),
    };
}

function pruneRendererFileOpenTokens(senderId: number, now = Date.now()) {
    const tokens = rendererFileOpenTokens.get(senderId);
    if (!tokens) {
        return;
    }

    for (const [
        token,
        grant,
    ] of tokens.entries()) {
        if (grant.expiresAtMs <= now) {
            tokens.delete(token);
        }
    }

    if (tokens.size === 0) {
        rendererFileOpenTokens.delete(senderId);
    }
}

function registerRendererFileOpenTokenCleanup(event: IpcMainInvokeEvent, senderId: number) {
    if (rendererFileOpenTokenCleanupSenders.has(senderId)) {
        return;
    }

    rendererFileOpenTokenCleanupSenders.add(senderId);
    const cleanup = () => {
        event.sender.removeListener('destroyed', cleanup);
        event.sender.removeListener('render-process-gone', cleanup);
        event.sender.removeListener('did-start-navigation', handleNavigation);
        rendererFileOpenTokens.delete(senderId);
        rendererFileOpenTokenCleanupSenders.delete(senderId);
    };
    const handleNavigation = (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup();
        }
    };
    event.sender.once('destroyed', cleanup);
    event.sender.once('render-process-gone', cleanup);
    event.sender.on('did-start-navigation', handleNavigation);
}

function consumeRendererFileOpenToken(senderId: number, token: string) {
    pruneRendererFileOpenTokens(senderId);
    const tokens = rendererFileOpenTokens.get(senderId);
    const grant = tokens?.get(token);
    if (!tokens || !grant || grant.expiresAtMs <= Date.now()) {
        tokens?.delete(token);
        return false;
    }

    tokens.delete(token);
    if (tokens.size === 0) {
        rendererFileOpenTokens.delete(senderId);
    }
    return true;
}

function hasRendererFileOpenToken(senderId: number, token: string) {
    pruneRendererFileOpenTokens(senderId);
    const tokens = rendererFileOpenTokens.get(senderId);
    const grant = tokens?.get(token);
    if (!tokens || !grant || grant.expiresAtMs <= Date.now()) {
        tokens?.delete(token);
        return false;
    }
    return true;
}

function registerRendererFileOpenTokens(
    event: IpcMainInvokeEvent,
    tokensPayload: unknown,
) {
    const normalizedTokens = Array.isArray(tokensPayload)
        ? tokensPayload.map((token: unknown) => typeof token === 'string' ? token.trim() : '')
        : [];
    if (
        normalizedTokens.length === 0
        || normalizedTokens.length > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER
        || normalizedTokens.some(token => !RENDERER_FILE_OPEN_TOKEN_PATTERN.test(token))
        || new Set(normalizedTokens).size !== normalizedTokens.length
    ) {
        return false;
    }

    const senderId = getSenderId(event);
    const tokens = rendererFileOpenTokens.get(senderId) ?? new Map<string, IRendererFileOpenToken>();
    pruneRendererFileOpenTokens(senderId);
    const newTokenCount = normalizedTokens.filter(token => !tokens.has(token)).length;
    if (tokens.size + newTokenCount > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER) {
        return false;
    }

    const expiresAtMs = Date.now() + RENDERER_FILE_OPEN_TOKEN_TTL_MS;
    for (const token of normalizedTokens) {
        tokens.delete(token);
        tokens.set(token, {expiresAtMs});
    }
    rendererFileOpenTokens.set(senderId, tokens);
    registerRendererFileOpenTokenCleanup(event, senderId);
    return true;
}

function parseRendererFileOpenBatchRequests(requestsPayload: unknown) {
    if (
        !Array.isArray(requestsPayload)
        || requestsPayload.length === 0
        || requestsPayload.length > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER
    ) {
        return null;
    }

    const requests = requestsPayload.map((request: unknown) => {
        const filePath = isRecord(request) ? request.filePath : '';
        const token = isRecord(request) ? request.token : '';
        return {
            filePath: typeof filePath === 'string' ? filePath.trim() : '',
            token: typeof token === 'string' ? token.trim() : '',
        };
    });
    if (
        requests.some(request =>
            !request.filePath
            || !isAbsolute(request.filePath)
            || !RENDERER_FILE_OPEN_TOKEN_PATTERN.test(request.token))
        || new Set(requests.map(request => request.token)).size !== requests.length
    ) {
        return null;
    }
    return requests;
}

function isValidRendererFileOpenPath(filePath: string) {
    return existsSync(filePath) && isSupportedOpenPath(filePath);
}

async function requireWorkingCopySourcePath(event: IpcMainInvokeEvent, sourcePath: string): Promise<TOpenPath> {
    try {
        return requireOpenPath(sourcePath, event.sender);
    } catch {
        return requireManagedWorkingCopyPath(sourcePath, getSenderId(event));
    }
}

export function registerDocumentsIpcAdapter(
    registrar: TDocumentsIpcRegistrar,
    service: IDocumentsService = createDocumentsService(),
    options: IRegisterDocumentsIpcAdapterOptions = {},
) {
    const registeredChannels: string[] = [];
    const register = <TChannel extends TDocumentsIpcChannel>(
        channel: TChannel,
        handler: TIpcMainInvokeHandler<
            IDocumentsInvokeMap[TChannel]['args'],
            IDocumentsInvokeMap[TChannel]['result'],
            IpcMainInvokeEvent
        >,
    ) => {
        registeredChannels.push(channel);
        registrar.handle(channel, handler);
    };
    const registerRawEvent = (
        channel: typeof DOCUMENTS_CHANNELS.fileSavePdfDataPort,
        handler: (event: IpcMainEvent, ...args: unknown[]) => void,
    ) => {
        if (!options.eventRegistrar) {
            throw new Error(`Documents IPC event registrar is required for ${channel}`);
        }
        registeredChannels.push(channel);
        options.eventRegistrar.on(channel, handler);
    };

    const featureRegistrar = {handle: (channel: string, handler: TIpcMainInvokeHandler<
        unknown[],
        unknown,
        IpcMainInvokeEvent
    >) => {
        registeredChannels.push(channel);
        registrar.handle(channel as never, handler as never);
    }};
    const featureBindings = {
        openDocumentDialog: context => service.openDocumentDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openCombineDialog: context => service.openCombineDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openFolderDialog: context => service.openFolderDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openImageDialog: context => service.openImageDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        getRecentFiles: context => service.getRecentFiles(context),
        removeRecentFile: async (originalPath) => {
            await service.removeRecentFile(originalPath);
            return undefined;
        },
        clearRecentFiles: async () => {
            await service.clearRecentFiles();
            return undefined;
        },
        setWindowTitle: (context, title) => {
            service.setWindowTitle({
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, title);
            return undefined;
        },
        showItemInFolder: (context, filePath) =>
            service.showItemInFolder({owner: context.sender}, filePath),
        setMenuDocumentState: (context, state) => {
            service.setMenuDocumentState({
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, state);
            return undefined;
        },
        setMenuTabCount: (context, tabCount) => {
            service.setMenuTabCount({
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, tabCount);
            return undefined;
        },
    } satisfies
        TFeatureMainBindings<typeof DOCUMENT_PICKER_PLATFORM_FEATURE, IpcMainInvokeEvent>
        & TFeatureMainBindings<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE, IpcMainInvokeEvent>
        & TFeatureMainBindings<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE, IpcMainInvokeEvent>
        & TFeatureMainBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE, IpcMainInvokeEvent>;
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_PICKER_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_RECENT_FILES_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_WINDOW_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_MENU_PLATFORM_FEATURE, featureBindings);

    register(DOCUMENTS_CHANNELS.openDocumentDirect, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.openDocumentDirect>
    ) =>
        service.openDocumentDirect(createWebContentsContext(event), filePath));
    register(DOCUMENTS_CHANNELS.openDocumentDirectBatch, (
        event: IpcMainInvokeEvent,
        ...[
            filePaths,
            requestId,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.openDocumentDirectBatch>
    ) =>
        service.openDocumentDirectBatch(createWebContentsContext(event), filePaths, requestId, options));
    register(DOCUMENTS_CHANNELS.cancelOpenDocumentDirectBatch, (
        event: IpcMainInvokeEvent,
        ...[requestId]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.cancelOpenDocumentDirectBatch>
    ) => service.cancelOpenDocumentDirectBatch(createWebContentsContext(event), requestId));
    register(DOCUMENTS_CHANNELS.createWorkingCopyFromData, (
        event: IpcMainInvokeEvent,
        ...[
            fileName,
            data,
            originalPath,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.createWorkingCopyFromData>
    ) =>
        service.createWorkingCopyFromData(createSenderIdContext(event), fileName, data, originalPath));
    register(DOCUMENTS_CHANNELS.savePdfAs, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            options,
            revisionOptions,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.savePdfAs>
    ) =>
        service.savePdfAs(createDialogContext(event), workingPath, options, revisionOptions));
    register(DOCUMENTS_CHANNELS.savePdfDataAs, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            data,
            options,
            serializedSaveOptions,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.savePdfDataAs>
    ) =>
        service.savePdfDataAs(createDialogContext(event), workingPath, data, options, serializedSaveOptions));
    register(DOCUMENTS_CHANNELS.savePdfDataAsBegin, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            totalBytes,
            options,
            serializedSaveOptions,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.savePdfDataAsBegin>
    ) =>
        service.beginSavePdfDataAs(createDialogContext(event), workingPath, totalBytes, options, serializedSaveOptions));
    register(DOCUMENTS_CHANNELS.savePdfDialog, (
        event: IpcMainInvokeEvent,
        ...[suggestedName]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.savePdfDialog>
    ) =>
        service.savePdfDialog(createDialogContext(event), suggestedName));
    register(DOCUMENTS_CHANNELS.saveDocxAs, (
        event: IpcMainInvokeEvent,
        ...[workingPath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.saveDocxAs>
    ) =>
        service.saveDocxAs(createDialogContext(event), workingPath));
    register(DOCUMENTS_CHANNELS.fileRead, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileRead>
    ) => service.readFile(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.fileStat, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileStat>
    ) => service.statFile(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.fileReadRange, (
        event: IpcMainInvokeEvent,
        ...[
            filePath,
            offset,
            length,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileReadRange>
    ) =>
        service.readFileRange(createSenderIdContext(event), filePath, offset, length));
    register(DOCUMENTS_CHANNELS.fileCreateManagedHandle, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCreateManagedHandle>
    ) => service.createManagedTempFileHandle(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.fileReleaseManagedHandle, (
        event: IpcMainInvokeEvent,
        ...[leaseId]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileReleaseManagedHandle>
    ) => service.releaseManagedTempFileHandle(createSenderIdContext(event), leaseId));
    register(DOCUMENTS_CHANNELS.pdfOpeningGeometry, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfOpeningGeometry>
    ) =>
        service.getPdfOpeningGeometry(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.pdfNativePageSizes, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfNativePageSizes>
    ) =>
        service.getPdfNativePageSizes(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel, (
        event: IpcMainInvokeEvent,
        ...[requestId]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel>
    ) =>
        service.cancelPdfNativePagePreview(createSenderIdContext(event), requestId));
    register(DOCUMENTS_CHANNELS.pdfNativePagePreview, (
        event: IpcMainInvokeEvent,
        ...[
            filePath,
            pageNumber,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfNativePagePreview>
    ) =>
        service.renderPdfNativePagePreview(createSenderIdContext(event), filePath, pageNumber, options));
    register(DOCUMENTS_CHANNELS.fileReadText, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileReadText>
    ) =>
        service.readTextFile(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.fileExists, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileExists>
    ) =>
        service.fileExists(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.documentRevisionGet, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.documentRevisionGet>
    ) =>
        service.getDocumentRevision(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.pdfAnalyzeConformance, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfAnalyzeConformance>
    ) =>
        service.analyzePdfConformance(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.pdfValidateData, (
        event: IpcMainInvokeEvent,
        ...[
            data,
            fileName,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfValidateData>
    ) =>
        service.validatePdfData(data, fileName));
    register(DOCUMENTS_CHANNELS.pdfValidatePath, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfValidatePath>
    ) =>
        service.validatePdfPath(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData, (
        _event: IpcMainInvokeEvent,
        ...[
            data,
            fileName,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData>
    ) =>
        service.openPdfInDefaultAppData(data, fileName));
    register(DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath, (
        event: IpcMainInvokeEvent,
        ...[
            filePath,
            fileName,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath>
    ) =>
        service.openPdfInDefaultAppPath(createSenderIdContext(event), filePath, fileName));
    register(DOCUMENTS_CHANNELS.pdfPrintData, (
        event: IpcMainInvokeEvent,
        ...[
            data,
            fileName,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfPrintData>
    ) =>
        service.printPdfData(createWindowContext(event), data, fileName));
    register(DOCUMENTS_CHANNELS.pdfPrintPath, (
        event: IpcMainInvokeEvent,
        ...[
            filePath,
            fileName,
            pageNumbers,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.pdfPrintPath>
    ) =>
        service.printPdfPath(createWindowContext(event), filePath, fileName, pageNumbers));
    register(DOCUMENTS_CHANNELS.fileWrite, (
        event: IpcMainInvokeEvent,
        ...[
            filePath,
            data,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileWrite>
    ) =>
        service.writeFile(createSenderIdContext(event), filePath, data, options));
    register(DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath, (
        event: IpcMainInvokeEvent,
        ...[
            workingCopyPath,
            sourcePath,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath>
    ) =>
        service.replaceWorkingCopyFromPath(createSenderIdContext(event), workingCopyPath, sourcePath, options));
    register(DOCUMENTS_CHANNELS.fileWriteDocx, (
        event: IpcMainInvokeEvent,
        ...[
            filePath,
            data,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileWriteDocx>
    ) =>
        service.writeDocxFile(createSenderIdContext(event), filePath, data));
    register(DOCUMENTS_CHANNELS.fileSaveStructured, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSaveStructured>
    ) =>
        service.saveFileStructured(createSenderIdContext(event), workingPath, options));
    register(DOCUMENTS_CHANNELS.fileResyncWorkingCopy, (
        event: IpcMainInvokeEvent,
        ...[workingPath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileResyncWorkingCopy>
    ) =>
        service.resyncWorkingCopy(createSenderIdContext(event), workingPath));
    register(DOCUMENTS_CHANNELS.fileRepairPdf, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileRepairPdf>
    ) =>
        service.repairPdf(createSenderIdContext(event), workingPath, options));
    register(DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction>
    ) =>
        service.optimizePdfForInteraction(createSenderIdContext(event), workingPath, options));
    register(DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            options,
            requestId,
            revisionOptions,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy>
    ) =>
        service.optimizePdfAsCopy(createDialogContext(event), workingPath, options, requestId, revisionOptions));
    register(DOCUMENTS_CHANNELS.fileSavePdfData, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            data,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfData>
    ) =>
        service.savePdfData(createSenderIdContext(event), workingPath, data, options));
    register(DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            updates,
            modifiedAt,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates>
    ) =>
        service.savePdfNoteTextUpdates(createSenderIdContext(event), workingPath, updates, modifiedAt, options));
    register(DOCUMENTS_CHANNELS.fileSavePdfNoteChanges, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            changes,
            modifiedAt,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfNoteChanges>
    ) =>
        service.savePdfNoteChanges(createSenderIdContext(event), workingPath, changes, modifiedAt, options));
    register(DOCUMENTS_CHANNELS.fileSavePdfNativeMutations, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            mutations,
            modifiedAt,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfNativeMutations>
    ) =>
        service.savePdfNativeMutations(createSenderIdContext(event), workingPath, mutations, modifiedAt, options));
    register(DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            mutations,
            modifiedAt,
            expectedBase,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy>
    ) =>
        service.applyPdfNativeMutationsToWorkingCopy(
            createSenderIdContext(event),
            workingPath,
            mutations,
            modifiedAt,
            expectedBase,
            options,
        ));
    register(DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            stagedOutput,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations>
    ) => service.commitStagedPdfNativeMutations(
        createSenderIdContext(event),
        workingPath,
        stagedOutput,
        options,
    ));
    register(DOCUMENTS_CHANNELS.fileSavePdfDataBegin, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            totalBytes,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfDataBegin>
    ) =>
        service.beginSavePdfData(createWebContentsContext(event), workingPath, totalBytes, options));
    register(DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf, (
        event: IpcMainInvokeEvent,
        ...[
            sessionId,
            stagedOutput,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf>
    ) => service.commitStagedSerializedPdf(
        createSenderIdContext(event),
        sessionId,
        stagedOutput,
    ));
    register(DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf, (
        event: IpcMainInvokeEvent,
        ...[
            sessionId,
            stagedOutput,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf>
    ) => service.cancelStagedSerializedPdf(
        createSenderIdContext(event),
        sessionId,
        stagedOutput,
    ));
    register(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, (
        event: IpcMainInvokeEvent,
        ...[filePath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCleanupOcrTemp>
    ) =>
        service.cleanupOcrTemp(createSenderIdContext(event), filePath));
    register(DOCUMENTS_CHANNELS.registerRendererFileOpenToken, (event: IpcMainInvokeEvent, token: unknown) => {
        const normalizedToken = typeof token === 'string' ? token.trim() : '';
        return registerRendererFileOpenTokens(event, [normalizedToken]);
    });
    register(DOCUMENTS_CHANNELS.registerRendererFileOpenTokens, registerRendererFileOpenTokens);
    register(DOCUMENTS_CHANNELS.allowRendererFileOpen, (event: IpcMainInvokeEvent, request: unknown) => {
        const senderId = getSenderId(event);
        const filePath = isRecord(request) ? request.filePath : '';
        const token = isRecord(request) ? request.token : '';
        if (typeof token !== 'string' || !consumeRendererFileOpenToken(senderId, token)) {
            return false;
        }

        const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
        if (!normalizedPath || !isAbsolute(normalizedPath) || !isValidRendererFileOpenPath(normalizedPath)) {
            return false;
        }

        return allowOpenPath(normalizedPath, event.sender) !== null;
    });
    register(DOCUMENTS_CHANNELS.allowRendererFileOpenBatch, (event: IpcMainInvokeEvent, requestsPayload: unknown) => {
        const senderId = getSenderId(event);
        const requests = parseRendererFileOpenBatchRequests(requestsPayload);
        if (
            !requests
            || requests.some(request => !hasRendererFileOpenToken(senderId, request.token))
            || requests.some(request => !isValidRendererFileOpenPath(request.filePath))
        ) {
            return false;
        }

        for (const request of requests) {
            consumeRendererFileOpenToken(senderId, request.token);
        }
        return requests.every(request => allowOpenPath(request.filePath, event.sender) !== null);
    });
    register(
        DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
        (
            event: IpcMainInvokeEvent,
            ...[
                sourcePath,
                originalPath,
            ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.createWorkingCopyFromPath>
        ) =>
            requireWorkingCopySourcePath(event, sourcePath)
                .then(trustedSourcePath =>
                    service.createWorkingCopyFromPath(createSenderIdContext(event), trustedSourcePath, originalPath)),
    );
    register(DOCUMENTS_CHANNELS.fileCleanup, (
        event: IpcMainInvokeEvent,
        ...[workingPath]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCleanup>
    ) => service.cleanupFile(createSenderIdContext(event), workingPath)
        .then(() => undefined));
    registerRawEvent(DOCUMENTS_CHANNELS.fileSavePdfDataPort, (event: IpcMainEvent, sessionId: unknown) => {
        try {
            attachSerializedPdfPersistencePort(event, sessionId);
        } catch (error) {
            logger.warn(`[ipc] rejected ${DOCUMENTS_CHANNELS.fileSavePdfDataPort}: ${getErrorMessage(error)}`);
        }
    });
    assertDocumentsIpcSingleRegistrationInvariant(registeredChannels);
}
