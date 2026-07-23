import type {
    Component,
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    TFitMode,
    TPdfViewMode,
    TPrintOrientation,
    TZoomMode,
} from '@contracts/shared';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    IDocumentViewerExpose,
    IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import {
    isPathPdfSource,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/public';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type { IWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import {
    getWorkspaceViewerAdapter,
    resolveWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IWorkspaceViewerAdapter } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import type {
    IDocumentPageSource,
    IDocumentSourceCapabilities,
} from '@app/utils/document-viewer/source/documentPageSource';
import type { IDocumentSearchMatch } from '@app/utils/document-viewer/search/documentSearch';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import {
    createDocumentSession,
    ensurePdfProjection,
} from '@app/utils/document-viewer/session/documentSession';

export type TWorkspaceDocumentDriverId = 'pdfjs' | 'native-pdf' | 'djvu';
type TReadableRef<T> = ComputedRef<T> | Ref<T>;

const PDF_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: true,
    directImageExport: true,
    outline: true,
    pageEdits: true,
    search: true,
    text: true,
};

export interface IWorkspaceDocumentDriverSource {
    kind: 'pdf' | 'djvu';
    path: TDocumentRef | null;
}

export interface IWorkspaceDocumentDriverView {
    component: Component;
    sourcePath: TDocumentRef | null;
    defaultSourceCapabilities: IDocumentSourceCapabilities | null;
    showDjvuSource: boolean;
    showNativePdf: boolean;
    showPdfSidebar: boolean;
    startupVisualSource: 'native-pdf-src' | 'djvu-src' | null;
}

export interface IWorkspaceDriverPrintRequest {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export interface IWorkspaceDriverCommand {
    kind: 'prepare-print';
    request: IWorkspaceDriverPrintRequest;
    fileName: string | null;
    sourceCapabilities: IDocumentSourceCapabilities;
    onNativePrintHandoffStart?: () => void;
    signal?: AbortSignal;
}

export type TWorkspaceDriverCommandResult =
    | {status: 'completed'}
    | {
        status: 'unavailable';
        capability: keyof IWorkspaceViewerCapabilities;
    };

export interface IWorkspaceDocumentDriver {
    readonly id: TWorkspaceDocumentDriverId;
    readonly capabilities: Readonly<IWorkspaceViewerCapabilities>;
    readonly canPreparePrint: boolean;
    readonly source: IWorkspaceDocumentDriverSource;
    readonly view: IWorkspaceDocumentDriverView;
    run(command: IWorkspaceDriverCommand): Promise<TWorkspaceDriverCommandResult>;
}

interface IWorkspaceDocumentDriverSources {
    djvuSourcePath: Ref<TDocumentRef | null>;
    nativePdfSourcePath: TReadableRef<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

export interface IWorkspaceDocumentDriverOptions {
    djvuSourcePath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    pendingDocumentPath?: TReadableRef<TDocumentRef | null>;
    pendingDocumentSize?: TReadableRef<number | null>;
}

function createDriverPrintRequestId() {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createDriverPrintAbortError() {
    const error = new Error('Print preparation was canceled');
    error.name = 'AbortError';
    return error;
}

function throwIfDriverPrintAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw createDriverPrintAbortError();
    }
}

function createPrintProjectionSource(kind: 'pdf' | 'djvu', documentRef: TDocumentRef): IDocumentPageSource {
    const unavailable = () => Promise.reject(new Error('Print projection source cannot render pages'));
    return {
        kind,
        documentRef,
        pageCount: 0,
        getPageMetrics: unavailable,
        renderPage: unavailable,
        dispose() {},
    };
}

function runUnavailableDriverCommand(): Promise<TWorkspaceDriverCommandResult> {
    return Promise.resolve({
        status: 'unavailable',
        capability: 'print',
    });
}

async function prepareDjvuPrint(
    sources: IWorkspaceDocumentDriverSources,
    command: IWorkspaceDriverCommand,
): Promise<TWorkspaceDriverCommandResult> {
    const sourcePath = sources.djvuSourcePath.value;
    if (!sourcePath) {
        return {
            status: 'unavailable',
            capability: 'print',
        };
    }
    const requestId = createDriverPrintRequestId();
    const jobId = `djvu-print-${requestId}`;
    let cancelRequested = false;
    const cancelPrint = () => {
        cancelRequested = true;
        void getDjvuCapability().cancel(jobId).catch(() => undefined);
    };
    throwIfDriverPrintAborted(command.signal);
    command.signal?.addEventListener('abort', cancelPrint, { once: true });
    try {
        const printSession = createDocumentSession({
            id: `${String(sourcePath)}:${requestId}`,
            originalRef: sourcePath,
            source: createPrintProjectionSource('djvu', sourcePath),
            capabilities: command.sourceCapabilities,
        });
        const projectionSignal = command.signal ?? new AbortController().signal;
        await ensurePdfProjection(printSession, {build: async () => {
            const result = await getDjvuCapability().printDjvuPath(sourcePath, {
                ...command.request,
                requestId,
                pdfStrategy: 'compact-djvu-aware',
                ...(command.fileName ? { fileName: command.fileName } : {}),
            });
            if (command.signal?.aborted || cancelRequested || result.canceled) {
                throw createDriverPrintAbortError();
            }
            if (!result.success) {
                throw new Error(result.error ?? 'DjVu print preparation failed');
            }
            const outputState = await getDjvuCapability().getJobState(result.jobId ?? jobId);
            if (
                outputState?.operation !== 'djvu-print'
                || (outputState.status !== 'handoff' && outputState.status !== 'completed')
                || !('artifactPath' in outputState)
                || !outputState.artifactPath
            ) {
                throw new Error('DjVu print completed without an accepted output-service handoff');
            }
            return {
                documentRef: outputState.artifactPath,
                source: createPrintProjectionSource('pdf', outputState.artifactPath),
                capabilities: PDF_SOURCE_CAPABILITIES,
            };
        }}, 'print', projectionSignal);
        command.onNativePrintHandoffStart?.();
        return {status: 'completed'};
    } finally {
        command.signal?.removeEventListener('abort', cancelPrint);
    }
}

export function createWorkspaceDocumentDriverForAdapter(
    adapter: IWorkspaceViewerAdapter,
    sources: IWorkspaceDocumentDriverSources,
): IWorkspaceDocumentDriver {
    const isDjvu = adapter.id === 'djvu';
    const isNativePdf = adapter.id === 'native-pdf';
    return {
        id: isDjvu ? 'djvu' : isNativePdf ? 'native-pdf' : 'pdfjs',
        capabilities: adapter.capabilities,
        get canPreparePrint() {
            return isDjvu && sources.djvuSourcePath.value !== null;
        },
        get source(): IWorkspaceDocumentDriverSource {
            return {
                kind: isDjvu ? 'djvu' : 'pdf',
                path: isDjvu
                    ? sources.djvuSourcePath.value
                    : sources.workingCopyPath.value,
            };
        },
        get view(): IWorkspaceDocumentDriverView {
            return {
                component: adapter.component,
                sourcePath: isDjvu
                    ? sources.djvuSourcePath.value
                    : isNativePdf
                        ? sources.nativePdfSourcePath.value
                        : null,
                defaultSourceCapabilities: isDjvu || isNativePdf
                    ? null
                    : PDF_SOURCE_CAPABILITIES,
                showDjvuSource: isDjvu,
                showNativePdf: isNativePdf,
                showPdfSidebar: !isDjvu && !isNativePdf,
                startupVisualSource: isDjvu
                    ? 'djvu-src'
                    : isNativePdf
                        ? 'native-pdf-src'
                        : null,
            };
        },
        run: isDjvu
            ? command => prepareDjvuPrint(sources, command)
            : runUnavailableDriverCommand,
    };
}

export function getWorkspaceViewerAdapterForDocumentDriver(
    driver: IWorkspaceDocumentDriver,
): IWorkspaceViewerAdapter {
    return getWorkspaceViewerAdapter(driver.id === 'pdfjs' ? 'pdf' : driver.id);
}

export const useWorkspaceDocumentDriver = (
    options: IWorkspaceDocumentDriverOptions,
) => {
    const nativePdfSourcePath = computed(() => {
        const source = options.pdfSrc.value;
        if (!shouldUseNativePdfPreview(source) || !isPathPdfSource(source)) {
            return null;
        }
        return source.path;
    });
    const pendingDocumentKind = computed(() => getDocumentKindFromPath(options.pendingDocumentPath?.value ?? ''));
    const pendingNativePdf = computed(() => {
        const path = options.pendingDocumentPath?.value ?? null;
        const size = options.pendingDocumentSize?.value ?? null;
        return pendingDocumentKind.value === 'pdf'
            && path !== null
            && size !== null
            && shouldUseNativePdfPreview({
                kind: 'path',
                path,
                size,
            });
    });
    const sources = {
        djvuSourcePath: options.djvuSourcePath,
        nativePdfSourcePath,
        workingCopyPath: options.workingCopyPath,
    };
    const drivers = {
        djvu: createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('djvu'), sources),
        nativePdf: createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('native-pdf'), sources),
        pdfjs: createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('pdf'), sources),
    };
    const activeDocumentDriver = computed(() => {
        const adapter = resolveWorkspaceViewerAdapter({
            djvuSourcePath: options.djvuSourcePath.value
                ?? (pendingDocumentKind.value === 'djvu' ? options.pendingDocumentPath?.value ?? null : null),
            isDjvuMode: options.isDjvuMode.value || pendingDocumentKind.value === 'djvu',
            pdfSourcePath: isPathPdfSource(options.pdfSrc.value)
                ? options.pdfSrc.value.path
                : options.pdfSrc.value
                    ? 'document.pdf'
                    : pendingDocumentKind.value === 'pdf'
                        ? options.pendingDocumentPath?.value ?? null
                        : null,
            shouldUseNativePdf: Boolean(nativePdfSourcePath.value) || pendingNativePdf.value,
        });
        if (adapter?.id === 'djvu') {
            return drivers.djvu;
        }
        if (adapter?.id === 'native-pdf') {
            return drivers.nativePdf;
        }
        return adapter ? drivers.pdfjs : null;
    });

    return {
        activeDocumentDriver,
        mountedDocumentDriver: computed(() => activeDocumentDriver.value ?? drivers.pdfjs),
    };
};

type TWorkspaceActiveViewerAdapterOptions = Omit<
    IWorkspaceDocumentDriverOptions,
    'workingCopyPath'
>;

// Compatibility façade. Remove when Stage 4 deletes the adapter API.
export const useWorkspaceActiveViewerAdapter = (
    options: TWorkspaceActiveViewerAdapterOptions,
) => {
    const driver = useWorkspaceDocumentDriver({
        ...options,
        workingCopyPath: ref(null),
    });
    return {
        activeViewerAdapter: computed(() => driver.activeDocumentDriver.value
            ? getWorkspaceViewerAdapterForDocumentDriver(driver.activeDocumentDriver.value)
            : null),
        activeViewerCapabilities: computed(() => driver.activeDocumentDriver.value?.capabilities),
        nativePdfSourcePath: computed(() => (
            driver.activeDocumentDriver.value?.id === 'native-pdf'
                ? driver.activeDocumentDriver.value.view.sourcePath
                : null
        )),
    };
};

export interface IWorkspaceDocumentDriverBindingOptions {
    activeDocumentDriver: ComputedRef<IWorkspaceDocumentDriver>;
    annotationCursorMode: TReadableRef<unknown>;
    annotationKeepActive: TReadableRef<unknown>;
    annotationSettings: TReadableRef<unknown>;
    annotationTool: Ref<unknown>;
    authorName: TReadableRef<string>;
    continuousScroll: Ref<boolean>;
    currentResultNavigationId: Ref<number>;
    currentSearchMatch: TReadableRef<unknown>;
    documentSourceCurrentResultIndex: TReadableRef<number>;
    documentSourceSearchResults: TReadableRef<readonly IDocumentSearchMatch[]>;
    currentPage: Ref<number>;
    dragMode: Ref<boolean>;
    fitMode: Ref<TFitMode>;
    isAnySaving: Ref<boolean>;
    isRenderActive: TReadableRef<boolean>;
    isWorkspaceLayoutResizing: TReadableRef<boolean>;
    pageMatches: TReadableRef<unknown>;
    pdfRasterDisplayProfile: TReadableRef<TPdfRasterDisplayProfile | null>;
    pdfReloadSrc: Ref<TPdfSource | null>;
    pdfSrc: Ref<TPdfSource | null>;
    pendingDocumentPath?: TReadableRef<TDocumentRef | null>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    nativePdfViewerRef: Ref<IDocumentViewerExpose | null>;
    djvuViewerRef: Ref<IDocumentViewerExpose | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    sourcePdfData: TReadableRef<Uint8Array | null>;
    viewMode: Ref<TPdfViewMode>;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    zoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    onAnnotationCommentClick: unknown;
    onAnnotationComments: unknown;
    onAnnotationContextMenu: unknown;
    onAnnotationModified: unknown;
    onAnnotationNotePlacementChange: (value: boolean) => void;
    onAnnotationOpenNote: unknown;
    onAnnotationSetting: unknown;
    onAnnotationState: unknown;
    onAnnotationToolAutoReset: () => void;
    onAnnotationToolCancel: () => void;
    onCurrentPageUpdate: (value: number) => void;
    onDocumentUpdate: (value: unknown) => void;
    onEffectiveZoomUpdate: (value: number) => void;
    onFitModeUpdate: (value: TFitMode) => void;
    onImagePlacementFinalize: unknown;
    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
    onLoadError: (error: unknown) => void;
    onLoading: (value: boolean) => void;
    onNavigationFeedbackPageUpdate: (value: number | null) => void;
    onShapeContextMenu: unknown;
    onSourceCapabilitiesUpdate: (capabilities: IDocumentSourceCapabilities) => void;
    onPageSourceUpdate: (source: IDocumentPageSource | null) => void;
    onTotalPagesUpdate: (value: number) => void;
    onZoomModeUpdate: (value: TZoomMode) => void;
    onZoomUpdate: (value: number) => void;
}

export const useWorkspaceDocumentDriverBinding = (options: IWorkspaceDocumentDriverBindingOptions) => {
    function setViewerRef<T>(target: Ref<T | null>, value: T | null) {
        if (target.value !== value) {
            target.value = value;
        }
    }

    function createNativeViewerProps(source: TDocumentRef | null) {
        return {
            src: source,
            zoom: options.zoom.value,
            zoomMode: options.zoomMode.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            continuousScroll: options.continuousScroll.value,
            dragMode: options.dragMode.value,
            documentRevisionToken: options.documentRevisionToken.value,
            isActive: options.isRenderActive.value,
        };
    }

    const activeViewerProps = computed<Record<string, unknown>>(() => {
        const driver = options.activeDocumentDriver.value;
        if (driver.id === 'pdfjs') {
            return {
                sourceKind: 'pdf',
                src: options.pdfSrc.value,
                reloadSrc: options.pdfReloadSrc.value,
                rasterDisplayProfile: options.pdfRasterDisplayProfile.value,
                sourcePdfData: options.sourcePdfData.value,
                isAnySaving: options.isAnySaving.value,
                zoom: options.zoom.value,
                zoomMode: options.zoomMode.value,
                fitMode: options.fitMode.value,
                viewMode: options.viewMode.value,
                currentPage: options.currentPage.value,
                dragMode: options.dragMode.value,
                continuousScroll: options.continuousScroll.value,
                isResizing: options.isWorkspaceLayoutResizing.value,
                isActive: options.isRenderActive.value,
                annotationTool: options.annotationTool.value,
                annotationCursorMode: options.annotationCursorMode.value,
                annotationKeepActive: options.annotationKeepActive.value,
                annotationSettings: options.annotationSettings.value,
                searchPageMatches: options.pageMatches.value,
                currentSearchMatch: options.currentSearchMatch.value,
                currentSearchMatchNavigationId: options.currentResultNavigationId.value,
                workingCopyPath: options.workingCopyPath.value,
                originalPath: options.originalPath.value ?? options.pendingDocumentPath?.value ?? null,
                documentRevisionToken: options.documentRevisionToken.value,
                authorName: options.authorName.value,
            };
        }

        const nativeProps = createNativeViewerProps(driver.view.sourcePath);
        return driver.id === 'djvu'
            ? {
                ...nativeProps,
                sourceKind: 'djvu',
                rendererKind: 'page-source',
                isResizing: options.isWorkspaceLayoutResizing.value,
                searchResults: options.documentSourceSearchResults.value,
                currentSearchResultIndex: options.documentSourceCurrentResultIndex.value,
            }
            : {
                ...nativeProps,
                sourceKind: 'pdf',
                rendererKind: 'native-pdf',
            };
    });

    const activeViewerComponent = computed(() => options.activeDocumentDriver.value.view.component);

    const nativeViewerListeners = {
        'update:zoom': options.onZoomUpdate,
        'update:zoomMode': options.onZoomModeUpdate,
        'update:effectiveZoom': options.onEffectiveZoomUpdate,
        'update:currentPage': options.onCurrentPageUpdate,
        'update:totalPages': options.onTotalPagesUpdate,
        'update:document': options.onDocumentUpdate,
        loading: options.onLoading,
        loadError: options.onLoadError,
        initialVisualPending: options.onInitialVisualPending,
        initialVisualReady: options.onInitialVisualReady,
        'update:sourceCapabilities': options.onSourceCapabilitiesUpdate,
        'update:pageSource': options.onPageSourceUpdate,
    };

    const activeViewerListeners = computed<Record<string, unknown>>(() => {
        if (options.activeDocumentDriver.value.id !== 'pdfjs') {
            return nativeViewerListeners;
        }

        return {
            ...nativeViewerListeners,
            'update:fitMode': options.onFitModeUpdate,
            'update:navigationFeedbackPage': options.onNavigationFeedbackPageUpdate,
            annotationState: options.onAnnotationState,
            annotationModified: options.onAnnotationModified,
            annotationComments: options.onAnnotationComments,
            annotationOpenNote: options.onAnnotationOpenNote,
            annotationCommentClick: options.onAnnotationCommentClick,
            annotationContextMenu: options.onAnnotationContextMenu,
            annotationToolAutoReset: options.onAnnotationToolAutoReset,
            annotationToolCancel: options.onAnnotationToolCancel,
            annotationSetting: options.onAnnotationSetting,
            annotationNotePlacementChange: options.onAnnotationNotePlacementChange,
            shapeContextMenu: options.onShapeContextMenu,
            imagePlacementFinalize: options.onImagePlacementFinalize,
        };
    });

    function bindActiveViewerRef(instance: unknown) {
        const driverId = options.activeDocumentDriver.value.id;
        setViewerRef(
            options.pdfViewerRef,
            driverId === 'pdfjs' && instance
                ? instance as IPdfViewerExpose
                : null,
        );
        setViewerRef(
            options.nativePdfViewerRef,
            driverId === 'native-pdf' && instance
                ? instance as IDocumentViewerExpose
                : null,
        );
        setViewerRef(
            options.djvuViewerRef,
            driverId === 'djvu' && instance
                ? instance as IDocumentViewerExpose
                : null,
        );
    }

    return {
        activeViewerComponent,
        activeViewerProps,
        activeViewerListeners,
        bindActiveViewerRef,
    };
};

type TWorkspaceViewerAdapterBindingOptions = Omit<
    IWorkspaceDocumentDriverBindingOptions,
    'activeDocumentDriver'
> & {
    activeViewerAdapter: ComputedRef<IWorkspaceViewerAdapter | null>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    nativePdfSourcePath: TReadableRef<TDocumentRef | null>;
};

// Compatibility façade. Remove when Stage 4 deletes the adapter API.
export const useWorkspaceViewerAdapterBinding = (
    options: TWorkspaceViewerAdapterBindingOptions,
) => useWorkspaceDocumentDriverBinding({
    ...options,
    activeDocumentDriver: computed(() => createWorkspaceDocumentDriverForAdapter(
        options.activeViewerAdapter.value
            ?? (() => {
                throw new Error('Workspace viewer binding requires an active adapter');
            })(),
        {
            djvuSourcePath: options.djvuSourcePath,
            nativePdfSourcePath: options.nativePdfSourcePath,
            workingCopyPath: options.workingCopyPath,
        },
    )),
});
