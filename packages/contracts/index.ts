export type {
    ILocaleDefinition,
    TLocaleFile,
} from '@contracts/i18n';

export type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
    TIpcMainInvokeHandler,
} from '@contracts/ipcMain';

export type {
    IAppUpdateStatus,
    IAgentCapability,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentDocumentOcrState,
    IAgentDocumentReadiness,
    IAgentDocumentRecommendation,
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    IAgentPaneSnapshot,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    IDebugLogEntry,
    IDjvuCapability,
    IDocumentsCapability,
    IDocumentsFileCapability,
    IDocumentsMenuCapability,
    IImageExportCapability,
    IPageOpsCapability,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
    IOcrCapability,
    IPlatformApi,
    IRendererLogEntry,
    ISearchCapability,
    ISettingsCapability,
    IUpdatesCapability,
    IWindowTabsCapability,
    TAgentCommand,
    TAgentCommandName,
    TAgentDocumentKind,
    TAgentDocumentReadinessStatus,
    TAgentMcpCodexRegistrationState,
    TAgentOcrCoverageStatus,
    TAgentRecommendationId,
    TAppUpdateCheckOrigin,
    TAppUpdatePhase,
    TOpenFileResult,
} from '@contracts/platformApi';
export type { IElectronAPI } from '@contracts/electronApi';

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
} from '@contracts/viewerHost';

export {
    READER_COMMAND_CATEGORIES,
    READER_COMMAND_DESCRIPTORS,
    READER_COMMANDS,
} from '@contracts/readerCommands';
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
} from '@contracts/readerCommands';

export type { TDocumentRef } from '@contracts/documentRef';

export type {
    IEditorPaneRect,
    IEditorPaneState,
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TPaneDirection,
    TPaneOrientation,
} from '@contracts/editorPanes';

export {
    MAX_IPC_PATH_LENGTH,
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    isLikelyAbsolutePath,
} from '@contracts/ipcAssertions';

export {
    ALLOWED_EXTERNAL_PROTOCOLS,
    inspectAllowedExternalUrl,
    normalizeAllowedExternalUrl,
    parseAllowedExternalUrl,
    sanitizeAllowedExternalUrl,
} from '@contracts/externalUrl';

export type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export type {
    IPdfSearchExcerpt,
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchResult,
    ISearchPreloadClient,
} from '@contracts/search';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts/release';

export {
    AVAILABLE_OCR_LANGUAGES,
    AVAILABLE_OCR_LANGUAGE_CODES,
} from '@contracts/ocrLanguages';

export {
    DEFAULT_SETTINGS,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';

export {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';

export { isTimeoutError } from '@contracts/isTimeoutError';

export { normalizeAnalyticsScalar } from '@contracts/analytics';
export type {
    INormalizeAnalyticsScalarOptions,
    TAnalyticsScalarResult,
} from '@contracts/analytics';

export { getErrorMessage } from '@contracts/getErrorMessage';

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
} from '@contracts/shared';
export { isOcrWord } from '@contracts/shared';

export {
    OCR_TEXT_LAYER_INDEX_SOURCE,
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';

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
} from '@contracts/windowTabs';
