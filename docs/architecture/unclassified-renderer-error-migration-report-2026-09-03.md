# Unclassified renderer error migration report

This is the SEN-MIG-01 baseline for SEN-OPS-03. It was generated from
`BrowserLogger.error` calls under `app/` on 2026-09-03.

- Total logger calls: 76 in 45 files.
- Calls that still create `UNCLASSIFIED_RENDERER_ERROR`: 75 in 44 files.
- Receipt-aware UI projections: 4 calls. They still use the temporary fallback
  code, but pass that receipt into the existing fatal or runtime presentation.
- Existing receipt reuse: 1 call in `rendererErrorGuard.client.ts`. It makes no
  new occurrence.

No family-specific code is assigned here. T24 through T30 own that work. A
line below is a remaining logger migration location unless marked as receipt
reuse.

| Path | Lines | Notes |
| --- | --- | --- |
| `app/app.vue` | 447, 508 | 508 passes its receipt to the fatal presentation |
| `app/composables/useAppUpdates.ts` | 119, 162, 192, 209, 226, 249 | |
| `app/composables/useDjvu.ts` | 429, 632, 687 | |
| `app/composables/useOcr.ts` | 475, 549, 554 | |
| `app/composables/useSettings.ts` | 101, 131 | |
| `app/modules/agent-panel/composables/useAgentAssistantPanelController.ts` | 402 | Passes its receipt to the runtime presentation when it owns the log |
| `app/modules/native-pdf-viewer/components/NativePdfViewer.vue` | 1204, 1249 | |
| `app/modules/ocr-panel/runtime/useOcrPopupPresenter.ts` | 536 | |
| `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationSync.ts` | 1095 | |
| `app/modules/pdf-viewer/components/PdfOutline.vue` | 774 | |
| `app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox.ts` | 14, 56 | |
| `app/modules/pdf-viewer/engine/pdf-document-source/createPdfRangeRequestBridge.ts` | 299 | |
| `app/modules/pdf-viewer/engine/pdf-document-source/pdfjsDocumentTeardownCoordinator.ts` | 37 | |
| `app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations.ts` | 485 | Passes its receipt to the runtime presentation |
| `app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts` | 227 | |
| `app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery.ts` | 224, 247 | |
| `app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer.ts` | 291 | |
| `app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController.ts` | 50, 68 | |
| `app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession.ts` | 1120 | |
| `app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession.ts` | 632 | |
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
| `app/platform/lazyBrowserPlatformApi.ts` | 145 | |
| `app/plugins/rendererErrorGuard.client.ts` | 141 | Reuses the guard receipt, no fallback capture |
| `app/services/pdf/combinePdfFiles.ts` | 230 | |
| `app/utils/asyncGuard.ts` | 70 | |
