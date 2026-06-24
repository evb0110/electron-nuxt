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
    TDebugLogLevel,
    TMenuEventCallback,
    TMenuEventUnsubscribe,
    TRendererLogLevel,
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
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
    ISearchPreloadClient,
} from '@contracts/search';

export type {
    IMarkerRect,
    IPageGeometry,
    IPdfBox,
    IPoint2D,
} from '@contracts/geometry';

export type {
    TPageIndex,
    TPageNumber,
} from '@contracts/pageNumbers';
export {
    pageIndexToPageNumber,
    pageNumberToPageIndex,
    parsePageIndex,
    parsePageNumber,
    toPageIndex,
    toPageNumber,
} from '@contracts/pageNumbers';

export { PDF_PAGE_LABEL_STYLE_VALUES } from '@contracts/pdfPageLabels';
export type {
    IPdfPageLabelRange,
    IPdfPageLabelsMutation,
    TPdfPageLabelStyle,
} from '@contracts/pdfPageLabels';

export {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_MARKUP_SUBTYPES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
export type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
} from '@contracts/annotations';

export {
    PDF_NATIVE_DATE_PATTERN,
    PDF_NATIVE_MUTATION_ENUM_VALUES,
    PDF_NATIVE_MUTATION_LIMITS,
    PDF_NATIVE_SHA256_HEX_PATTERN,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
    normalizePdfNativeWorkingCopyExpectation,
} from '@contracts/nativePdfMutations';
export type {
    IPdfNativePlacedImageNativeToolPayload,
    IPdfNativeValidationOptions,
    TPdfNativeMutationSetNativeToolPayload,
} from '@contracts/nativePdfMutations';

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
    GREEK_OCR_LANGUAGE_CODES,
    RTL_OCR_LANGUAGE_CODES,
    isGreekOcrLanguage,
    isRtlOcrLanguage,
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

export {
    ANALYTICS_GEO_LIMITS,
    normalizeAnalyticsGeo,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';
export type {
    IAnalyticsGeoData,
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
    buildOcrWordKey,
    buildOcrTextLayerIndexText,
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';

export type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
    TOcrIndexRotation,
} from '@contracts/ocrIndex';

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
