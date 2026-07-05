import type { IIpcInvokeSpec } from '@contracts/ipcMain';
import type { IIpcInvokeArgumentValidationPolicy } from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    CORE_IPC_CHANNELS,
    type ICoreInvokeMap,
} from '@electron/platform-ipc/coreContract';
import {
    AGENT_CHANNELS,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import {
    DJVU_CHANNELS,
    type IDjvuInvokeMap,
} from '@electron/features/djvu/contract';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {
    IMAGE_EXPORT_CHANNELS,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/contract';
import {
    OCR_CHANNELS,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import {
    SEARCH_CHANNELS,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';

type TIpcInvokeChannel<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}> = Extract<keyof TMap, string>;
type TNoArgumentInvokeChannel<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}> = {
    [TChannel in TIpcInvokeChannel<TMap>]: TMap[TChannel]['args']['length'] extends 0 ? TChannel : never;
}[TIpcInvokeChannel<TMap>];
type TArgumentInvokeChannel<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}> =
    Exclude<TIpcInvokeChannel<TMap>, TNoArgumentInvokeChannel<TMap>>;

function createPolicy(
    noArgumentChannels: readonly string[],
    channelsValidatedWithoutRegistrarDecoder: readonly string[],
): IIpcInvokeArgumentValidationPolicy {
    return {
        noArgumentChannels: new Set(noArgumentChannels),
        channelsValidatedWithoutRegistrarDecoder: new Set(channelsValidatedWithoutRegistrarDecoder),
    };
}

const CORE_NO_ARGUMENT_INVOKE_CHANNELS = [
    CORE_IPC_CHANNELS.settingsGet,
    CORE_IPC_CHANNELS.updatesGetState,
    CORE_IPC_CHANNELS.updatesCheck,
    CORE_IPC_CHANNELS.updatesInstall,
    CORE_IPC_CHANNELS.updatesDefer,
    CORE_IPC_CHANNELS.windowCloseCurrent,
    CORE_IPC_CHANNELS.claimPendingExternalOpenPaths,
    CORE_IPC_CHANNELS.tabsListTargets,
    CORE_IPC_CHANNELS.hostGetEnvironment,
    CORE_IPC_CHANNELS.hostGetZenModeState,
] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<ICoreInvokeMap>>;

const CORE_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    CORE_IPC_CHANNELS.settingsSave,
    CORE_IPC_CHANNELS.updatesSkipVersion,
    CORE_IPC_CHANNELS.shellOpenExternal,
    CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths,
    CORE_IPC_CHANNELS.tabsTransfer,
    CORE_IPC_CHANNELS.tabsTransferAck,
    CORE_IPC_CHANNELS.tabsShowContextMenu,
    CORE_IPC_CHANNELS.hostSetZenMode,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<ICoreInvokeMap>>;

export const CORE_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    CORE_NO_ARGUMENT_INVOKE_CHANNELS,
    CORE_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);

const DOCUMENTS_NO_ARGUMENT_INVOKE_CHANNELS = [
    DOCUMENTS_CHANNELS.openDocumentDialog,
    DOCUMENTS_CHANNELS.openCombineDialog,
    DOCUMENTS_CHANNELS.openFolderDialog,
    DOCUMENTS_CHANNELS.openImageDialog,
    DOCUMENTS_CHANNELS.recentFilesGet,
    DOCUMENTS_CHANNELS.recentFilesClear,
] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<IDocumentsInvokeMap>>;

const DOCUMENTS_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    DOCUMENTS_CHANNELS.openDocumentDirect,
    DOCUMENTS_CHANNELS.openDocumentDirectBatch,
    DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
    DOCUMENTS_CHANNELS.registerRendererFileOpenTokens,
    DOCUMENTS_CHANNELS.allowRendererFileOpen,
    DOCUMENTS_CHANNELS.allowRendererFileOpenBatch,
    DOCUMENTS_CHANNELS.createWorkingCopyFromData,
    DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
    DOCUMENTS_CHANNELS.savePdfAs,
    DOCUMENTS_CHANNELS.savePdfDataAs,
    DOCUMENTS_CHANNELS.savePdfDataAsBegin,
    DOCUMENTS_CHANNELS.savePdfDialog,
    DOCUMENTS_CHANNELS.saveDocxAs,
    DOCUMENTS_CHANNELS.fileRead,
    DOCUMENTS_CHANNELS.fileStat,
    DOCUMENTS_CHANNELS.fileReadRange,
    DOCUMENTS_CHANNELS.pdfNativePageSizes,
    DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel,
    DOCUMENTS_CHANNELS.pdfNativePagePreview,
    DOCUMENTS_CHANNELS.fileReadText,
    DOCUMENTS_CHANNELS.fileExists,
    DOCUMENTS_CHANNELS.documentRevisionGet,
    DOCUMENTS_CHANNELS.pdfAnalyzeConformance,
    DOCUMENTS_CHANNELS.pdfValidateData,
    DOCUMENTS_CHANNELS.pdfValidatePath,
    DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData,
    DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath,
    DOCUMENTS_CHANNELS.pdfPrintData,
    DOCUMENTS_CHANNELS.pdfPrintPath,
    DOCUMENTS_CHANNELS.fileWrite,
    DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath,
    DOCUMENTS_CHANNELS.fileWriteDocx,
    DOCUMENTS_CHANNELS.fileSaveStructured,
    DOCUMENTS_CHANNELS.fileResyncWorkingCopy,
    DOCUMENTS_CHANNELS.fileRepairPdf,
    DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction,
    DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy,
    DOCUMENTS_CHANNELS.fileSavePdfData,
    DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
    DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates,
    DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
    DOCUMENTS_CHANNELS.fileSavePdfNativeMutations,
    DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy,
    DOCUMENTS_CHANNELS.fileCleanup,
    DOCUMENTS_CHANNELS.fileCleanupOcrTemp,
    DOCUMENTS_CHANNELS.windowSetTitle,
    DOCUMENTS_CHANNELS.shellShowItemInFolder,
    DOCUMENTS_CHANNELS.menuSetDocumentState,
    DOCUMENTS_CHANNELS.menuSetTabCount,
    DOCUMENTS_CHANNELS.recentFilesRemove,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<IDocumentsInvokeMap>>;

export const DOCUMENTS_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    DOCUMENTS_NO_ARGUMENT_INVOKE_CHANNELS,
    DOCUMENTS_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);

const AGENT_NO_ARGUMENT_INVOKE_CHANNELS = [
    AGENT_CHANNELS.getMcpIntegrationStatus,
    AGENT_CHANNELS.installAssistantCodex,
    AGENT_CHANNELS.cancelAssistantLogin,
] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<IAgentInvokeMap>>;

const AGENT_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    AGENT_CHANNELS.setMcpIntegrationEnabled,
    AGENT_CHANNELS.getAssistantState,
    AGENT_CHANNELS.startAssistantLogin,
    AGENT_CHANNELS.sendAssistantMessage,
    AGENT_CHANNELS.interruptAssistant,
    AGENT_CHANNELS.resetAssistantChat,
    AGENT_CHANNELS.submitWorkspaceSnapshot,
    AGENT_CHANNELS.submitCommandResponse,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<IAgentInvokeMap>>;

export const AGENT_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    AGENT_NO_ARGUMENT_INVOKE_CHANNELS,
    AGENT_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);

const IMAGE_EXPORT_NO_ARGUMENT_INVOKE_CHANNELS = [IMAGE_EXPORT_CHANNELS.subscribeProgress] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<IImageExportInvokeMap>>;

const IMAGE_EXPORT_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    IMAGE_EXPORT_CHANNELS.exportImages,
    IMAGE_EXPORT_CHANNELS.exportMultiPageTiff,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<IImageExportInvokeMap>>;

export const IMAGE_EXPORT_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    IMAGE_EXPORT_NO_ARGUMENT_INVOKE_CHANNELS,
    IMAGE_EXPORT_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);

const OCR_NO_ARGUMENT_INVOKE_CHANNELS = [
    OCR_CHANNELS.getLanguages,
    OCR_CHANNELS.validateTools,
    OCR_CHANNELS.preprocessingValidate,
    OCR_CHANNELS.subscribeProgress,
] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<IOcrInvokeMap>>;

const OCR_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    OCR_CHANNELS.recognize,
    OCR_CHANNELS.recognizeBatch,
    OCR_CHANNELS.createSearchablePdf,
    OCR_CHANNELS.cancel,
    OCR_CHANNELS.acknowledgeResultFile,
    OCR_CHANNELS.preprocessingPreprocessPage,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<IOcrInvokeMap>>;

export const OCR_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    OCR_NO_ARGUMENT_INVOKE_CHANNELS,
    OCR_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);

const SEARCH_NO_ARGUMENT_INVOKE_CHANNELS = [
    SEARCH_CHANNELS.resetCache,
    SEARCH_CHANNELS.subscribeProgress,
] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<ISearchInvokeMap>>;

const SEARCH_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    SEARCH_CHANNELS.search,
    SEARCH_CHANNELS.warmIndex,
    SEARCH_CHANNELS.cancel,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<ISearchInvokeMap>>;

export const SEARCH_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    SEARCH_NO_ARGUMENT_INVOKE_CHANNELS,
    SEARCH_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);

const DJVU_NO_ARGUMENT_INVOKE_CHANNELS = [DJVU_CHANNELS.subscribeProgress] as const satisfies ReadonlyArray<TNoArgumentInvokeChannel<IDjvuInvokeMap>>;

const DJVU_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS = [
    DJVU_CHANNELS.openForViewing,
    DJVU_CHANNELS.releaseViewingPath,
    DJVU_CHANNELS.convertToPdf,
    DJVU_CHANNELS.printDjvuPath,
    DJVU_CHANNELS.cancel,
    DJVU_CHANNELS.cancelPagePreview,
    DJVU_CHANNELS.getInfo,
    DJVU_CHANNELS.getPageSizes,
    DJVU_CHANNELS.renderPagePreview,
    DJVU_CHANNELS.estimateSizes,
    DJVU_CHANNELS.cleanupTemp,
] as const satisfies ReadonlyArray<TArgumentInvokeChannel<IDjvuInvokeMap>>;

export const DJVU_IPC_ARGUMENT_VALIDATION_POLICY = createPolicy(
    DJVU_NO_ARGUMENT_INVOKE_CHANNELS,
    DJVU_VALIDATED_WITHOUT_REGISTRAR_DECODER_INVOKE_CHANNELS,
);
