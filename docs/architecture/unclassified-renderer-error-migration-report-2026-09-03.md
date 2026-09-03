# Unclassified renderer error migration report

This is the SEN-MIG-01 inventory for SEN-OPS-03. It was generated from
`BrowserLogger.error` calls under `app/` on 2026-09-03.

The earlier baseline recorded 76 calls in 45 files before the sibling merges
landed in this assigned branch. The branch-base inventory for this worker was
82 calls in 49 files. After this migration it is 78 calls in 45 files.

- 17 allowed logger-only failure paths now pass a specific closed diagnostic
  code and bounded context.
- The renderer error guard now owns Vue, window, and unhandled-rejection
  projections with `RENDERER_ERROR_GUARD_FAILED`; its logger projection reuses
  the receipt.
- The runtime error log stream now owns receipt-free legacy ERROR projections
  and subscription initialization failures with
  `RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED`; main entries with a receipt are
  still presented without recapture.
- Four expected-outcome paths now use warning logging with no occurrence.
- The PDF range bridge no longer logs. Its document-session owner logs one
  range failure and reuses that receipt for the load-state projection.
- No allowed logger-only path in this inventory creates
  `UNCLASSIFIED_RENDERER_ERROR`.
- The remaining unclassified logger-only paths are excluded below because
  their owning worker covers updates, settings, workspace, DjVu, combine,
  scan-cleanup, annotation, or fatal UI behavior.

| Path | Lines | Notes |
| --- | --- | --- |
| `app/app.vue` | 553 | Owned by the settings/UI worker; unchanged here |
| `app/composables/useAppUpdates.ts` | 119, 162, 192, 209, 226, 249 | Owned by the settings/UI worker |
| `app/composables/useDjvu.ts` | 429, 632, 687 | Excluded DjVu path |
| `app/composables/useOcr.ts` | 485, 574 | Typed `RENDERER_OCR_BACKEND_FAILED` and `RENDERER_OCR_RUN_FAILED`; expected start refusals use warning logging |
| `app/composables/useSettings.ts` | 103, 134 | Owned by the settings/UI worker |
| `app/modules/agent-panel/composables/useAgentAssistantPanelController.ts` | 402 | Passes its receipt to the runtime presentation when it owns the log |
| `app/modules/native-pdf-viewer/components/NativePdfViewer.vue` | 1204, 1246 | Typed `RENDERER_NATIVE_PDF_VIEWER_FAILED` with initialize/resume context |
| `app/modules/ocr-panel/runtime/useOcrPopupPresenter.ts` | 536 | Clipboard refusal is warning-only; no occurrence |
| `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationSync.ts` | 1095 | |
| `app/modules/pdf-viewer/components/PdfOutline.vue` | 774 | Typed `RENDERER_PDF_OUTLINE_LOAD_FAILED` |
| `app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox.ts` | 14, 56 | Unsupported and invalid geometry are warning-only; no occurrence |
| `app/modules/pdf-viewer/engine/pdf-document-source/createPdfRangeRequestBridge.ts` |  | Logger removed; `pdfDocumentSession.ts` owns the failure |
| `app/modules/pdf-viewer/engine/pdf-document-source/pdfjsDocumentTeardownCoordinator.ts` | 37 | Expected teardown is warning-only; no occurrence |
| `app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations.ts` | 485 | Passes its receipt to the runtime presentation |
| `app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts` | 227 | Typed `RENDERER_PDF_IMAGE_RASTERIZATION_FAILED` |
| `app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery.ts` | 224, 251 | Typed `RENDERER_PDF_INITIAL_RENDER_RECOVERY_FAILED` with render/coordinate context |
| `app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer.ts` | 291 | Typed `RENDERER_PDF_PAGE_RENDER_FAILED` |
| `app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController.ts` | 50, 72 | Typed `RENDERER_PDF_SEARCH_OPERATION_FAILED` with operation context |
| `app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession.ts` | 1120 | Typed `RENDERER_PDF_VIEWPORT_PLACEMENT_FAILED` |
| `app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession.ts` | 224, 661, 663 | Typed range/document failures; load projection reuses the range receipt |
| `app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore.ts` | 258, 319, 384, 484 | |
| `app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash.ts` | 31 | |
| `app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue` | 662, 766 | |
| `app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts` | 481 | |
| `app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts` | 1143 | |
| `app/modules/workspace-shell/composables/useAppShellLifecycle.ts` | 43 | |
| `app/modules/workspace-shell/composables/useAppShellTabLifecycle.ts` | 115 | Passes its receipt to the runtime presentation |
| `app/modules/workspace-shell/composables/useAppShellWorkspaceRouting.ts` | 426 | |
| `app/modules/workspace-shell/composables/useDeferredWorkspaceChunkLoader.ts` | 22 | |
| `app/modules/workspace-shell/composables/useDocumentTransitions.ts` | 110 | |
| `app/modules/workspace-shell/composables/useDocumentWorkspaceToolbar.ts` | 58 | |
| `app/modules/workspace-shell/composables/useExternalFileDrop.ts` | 152 | |
| `app/modules/workspace-shell/composables/useNativeWindowCloseHandshake.ts` | 91 | |
| `app/modules/workspace-shell/composables/usePageFileOperations.ts` | 175, 207 | |
| `app/modules/workspace-shell/composables/useWindowTabTransfers.ts` | 391, 425, 477, 549, 713 | |
| `app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects.ts` | 323 | |
| `app/modules/workspace-shell/composables/useWorkspaceExport.ts` | 470, 532 | |
| `app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController.ts` | 238 | |
| `app/modules/workspace-shell/expose/createFallbackToolbarCommandListeners.ts` | 16 | |
| `app/modules/workspace-shell/host/createDeferredWorkspaceLoadGateway.ts` | 67, 134, 163, 183, 203, 226, 249 | |
| `app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen.ts` | 402 | |
| `app/platform/lazyBrowserPlatformApi.ts` | 145 | Typed `RENDERER_BROWSER_EVENT_SUBSCRIPTION_FAILED` |
| `app/plugins/rendererErrorGuard.client.ts` | 143 | Captures `RENDERER_ERROR_GUARD_FAILED` with source context; logger projection reuses the receipt |
| `app/plugins/runtimeErrorLogStream.client.ts` | 60, 131 | Reuses main receipts; receipt-free legacy and initialization paths use `RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED` with phase context |
| `app/services/pdf/combinePdfFiles.ts` | 253 | Excluded PDF-combine path |
| `app/utils/asyncGuard.ts` | 78 | User-visible failures use `RENDERER_ASYNC_GUARD_FAILED`; background failures are warning-only |
| `app/modules/combine/useCombinePdfOperation.ts` | 86, 122 | Excluded PDF-combine path |
| `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/reportAnnotationCreationFailure.ts` | 32 | Excluded annotation path |
| `app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts` | 179, 450, 496 | Excluded scan-cleanup path |
| `app/utils/getOrCaptureRendererBootstrapFailure.ts` | 28 | Existing fatal/bootstrap owner |
