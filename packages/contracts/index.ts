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
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPdfExternalCapability,
    IDocumentsPdfPersistenceCapability,
    IDocumentsPdfValidationCapability,
    IDocumentsPickerCapability,
    IDocumentsReadCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
    IImageExportCapability,
    IPageOpsCapability,
    IOcrCapability,
    IScanCleanupCapability,
    IPlatformApi,
    IPlatformApiDescriptor,
    IPlatformCapabilityDescriptor,
    IPlatformMethodDescriptor,
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
    TBrowserPlatformLazyMode,
    TPlatformMethodKind,
} from '@contracts/platformApi';
export {
    getPlatformDocumentCapabilityMirrors,
    getPlatformMethodDescriptor,
    PLATFORM_API_DESCRIPTOR,
} from '@contracts/platformApi';
export type { IElectronAPI } from '@contracts/electronApi';

export {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    decodeHostResourceProfileSnapshot,
    resolveDetectedHostResourceTier,
    resolveEffectiveHostResourceTier,
} from '@contracts/hostResourceProfile';
export type {
    IHostGpuStatusSnapshot,
    IHostResourceProfileSnapshot,
    IHostResourceTierInputs,
    THostResourceTier,
    TPerformanceMode,
} from '@contracts/hostResourceProfile';

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
export type * from '@contracts/documentRef';
export type { TDocumentInstanceId } from '@contracts/documentInstanceId';
export {
    parseDocumentInstanceId,
    requireDocumentInstanceId,
} from '@contracts/documentInstanceId';
export type * from '@contracts/platformUnsupported';
export type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    IDocumentRevisionStamp,
    TDocumentRevisionAuthority,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
export {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
export {
    DOCUMENT_MUTATION_ERROR_PREFIX,
    DocumentMutationError,
    createMissingRevisionError,
    createStaleRevisionError,
    createWorkingCopySyncRequiredError,
    encodeDocumentMutationError,
    getDocumentMutationErrorPayload,
    isDocumentMutationErrorCode,
    isMissingRevisionError,
    isStaleRevisionError,
    isWorkingCopySyncRequiredError,
} from '@contracts/documentMutationErrors';
export type {
    IDocumentMutationErrorPayload,
    TDocumentMutationErrorCode,
} from '@contracts/documentMutationErrors';

export {
    DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES,
    DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
    estimateDjvuPdfEffectivePixels,
    evaluateDjvuPdfConversionPolicy,
    normalizeDjvuPdfSubsample,
    resolveDjvuPdfExportStrategy,
    resolveRecommendedDjvuPdfSubsample,
} from '@contracts/djvuConversionPolicy';
export type {
    IDjvuConversionPageMetrics,
    IDjvuPdfConversionMetrics,
    IDjvuPdfConversionPolicyDecision,
    TDjvuPdfExportStrategy,
    TDjvuPdfResolvedExportStrategy,
} from '@contracts/djvuConversionPolicy';

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
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
    TPdfSearchUtf16Offset,
} from '@contracts/search';
export { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
export { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
export { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
export { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';
export { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';
export { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
export { HOST_PLATFORM_FEATURE } from '@contracts/hostPlatformFeature';

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
    requirePageIndex,
    requirePageNumber,
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
export {
    NATIVE_ERROR_CODES,
    hasNativeErrorCode,
    isNativeErrorEnvelope,
} from '@contracts/nativeErrors';
export type {
    INativeErrorEnvelope,
    TNativeErrorCode,
} from '@contracts/nativeErrors';

export {
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
    SEARCH_NATIVE_PROTOCOL_VERSION,
} from '@contracts/nativeToolProtocols';
export type { IGeneratedRustNativeToolProtocol } from '@contracts/nativeToolProtocols';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts/release';
export {
    RELEASE_ARCHES,
    RELEASE_PLATFORMS,
} from '@contracts/release';

export {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    PDF_PERSISTENCE_ERROR_CODES,
    PDF_PERSISTENCE_ERROR_PHASES,
    PDF_PERSISTENCE_MESSAGE_UNWRAP_DEPTH,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceAckFrame,
    createPdfPersistenceCancelFrame,
    createPdfPersistenceChunkFrame,
    createPdfPersistenceCompleteFrame,
    createPdfPersistenceErrorFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    describePdfPersistenceMessage,
    getPdfPersistenceChunkBytes,
    getPdfPersistenceErrorMessage,
    isPdfPersistencePreloadToMainPayload,
    isPdfValidationResult,
    isSerializedPdfPersistenceLimits,
    normalizePdfPersistencePreloadToMainPayload,
    parsePdfPersistenceMainToPreloadFrame,
} from '@contracts/documentPersistenceFrames';
export type {
    IPdfPersistenceAckFrame,
    IPdfPersistenceCancelFrame,
    IPdfPersistenceChunkFrame,
    IPdfPersistenceCompleteFrame,
    IPdfPersistenceErrorFrame,
    IPdfPersistencePreloadToMainPayload,
    IPdfPersistenceReadyFrame,
    IPdfPersistenceResultFrame,
    ISerializedPdfPersistenceLimits,
    TPdfPersistenceErrorCode,
    TPdfPersistenceErrorPhase,
    TPdfPersistenceMainToPreloadFrame,
    TPdfPersistencePreloadToMainFrame,
} from '@contracts/documentPersistenceFrames';

export {
    AVAILABLE_OCR_LANGUAGES,
    AVAILABLE_OCR_LANGUAGE_CODES,
    BUNDLED_OCR_LANGUAGE_CODES,
    BUNDLED_OCR_LANGUAGE_CODE_SET,
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
    isFiniteNumber,
    isFinitePositive,
    isErrnoException,
    isOneOf,
    isRecord,
    isSafeWorkerRequestId,
    isStringArray,
} from '@contracts/runtimeGuards';

export { safeJsonParse } from '@contracts/safeJsonParse';

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
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
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
export type {
    IWorkspaceCheckpoint,
    IWorkspaceCheckpointPane,
    IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';
export {decodeWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
