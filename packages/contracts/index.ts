export type {
    ILocaleDefinition,
    TLocaleFile,
} from './i18n';

export type {
    IIpcMainRegistrar,
    TIpcMainInvokeHandler,
} from './ipc-main';

export type {
    IAppUpdateStatus,
    IDebugLogEntry,
    IDjvuCapability,
    IDocumentsCapability,
    IDocumentsFileCapability,
    IDocumentsMenuCapability,
    IImageExportCapability,
    IPageOpsCapability,
    IElectronAPI,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
    IOcrCapability,
    IPlatformApi,
    IRendererLogEntry,
    ISearchCapability,
    ISettingsCapability,
    IUpdatesCapability,
    IWindowTabsCapability,
    TAppUpdateCheckOrigin,
    TAppUpdatePhase,
    TOpenFileResult,
} from './platform-api';

export type {
    IDesktopMenuCapability,
    IDesktopWindowCapability,
    IViewerAssetResolver,
    IViewerDocumentCapability,
    IViewerDocumentOutputCapability,
    IViewerDocumentPickerCapability,
    IViewerDocumentReadCapability,
    IViewerHostApi,
    IViewerHostEnvironment,
    IViewerSearchCapability,
    IViewerSettingsCapability,
    TViewerHostKind,
} from './viewer-host';

export {
    READER_COMMAND_CATEGORIES,
    READER_COMMAND_DESCRIPTORS,
    READER_COMMANDS,
} from './reader-commands';
export type {
    IReaderCommandDescriptor,
    IReaderCommandRequest,
    IReaderCommandSurface,
    IReaderCommandState,
    IReaderCommandStateSnapshot,
    TReaderCommandCategory,
    TReaderCommandId,
    TReaderCommandMap,
    TReaderCommandPlacement,
} from './reader-commands';

export type { TDocumentRef } from './document';

export type {
    IEditorGroupRect,
    IEditorGroupState,
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TGroupDirection,
    TGroupOrientation,
} from './editor-groups';

export {
    MAX_IPC_PATH_LENGTH,
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    isLikelyAbsolutePath,
} from './ipc-assertions';

export {
    ALLOWED_EXTERNAL_PROTOCOLS,
    inspectAllowedExternalUrl,
    normalizeAllowedExternalUrl,
    parseAllowedExternalUrl,
    sanitizeAllowedExternalUrl,
} from './external-url';

export type {IPdfBookmarkEntry} from './pdf';

export type {
    IPdfSearchExcerpt,
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchResult,
    ISearchPreloadClient,
} from './search';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from './release';

export {
    DEFAULT_SETTINGS,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from './settings';

export {
    EVB_RUNTIME_IDENTITY,
    getRuntimeIdentityUrl,
    isTrustedRuntimeIdentityPayload,
} from './runtime-identity';
export type { IRuntimeIdentityPayload } from './runtime-identity';

export { isTimeoutError } from './timeout-error';

export { getErrorMessage } from './error';

export type {
    IRecentFile,
    IOcrLanguage,
    IOcrWord,
    ISettingsData,
    TAppLocale,
    TAppTheme,
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from './shared';

export type {
    IDjvuSplitPayload,
    IEmptySplitPayload,
    IPdfSnapshotSplitPayload,
    ITransferredTabState,
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TSplitPayload,
    TWindowTabsAction,
    TWindowTabTransferTarget,
} from './window-tabs';
