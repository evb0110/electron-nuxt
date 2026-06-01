import type { Ref } from 'vue';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentDocumentReference,
    IAgentDocumentReadiness,
    IAgentRecentFileSnapshot,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    TAgentDocumentKind,
} from '@contracts/agent';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IRecentFile } from '@contracts/shared';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import {
    getPlatformAPI,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browserLogger';
import { guardAsync } from '@app/utils/asyncGuard';

interface IUseAgentWorkspaceSnapshotOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    recentFiles?: Ref<IRecentFile[]>;
    recentFilesResolved?: Ref<boolean>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    shouldWaitForDesktopBridge: () => boolean;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
    activateTab(paneId: string, tabId: string): void;
    waitForWorkspace(tabId: string): Promise<IWorkspaceExpose | null>;
}

const IMAGE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

function cloneEditorLayoutNode(node: TEditorLayoutNode | null): TEditorLayoutNode | null {
    if (!node) {
        return null;
    }

    if (node.type === 'leaf') {
        return {
            type: 'leaf',
            paneId: node.paneId,
        };
    }

    return {
        type: 'split',
        id: node.id,
        orientation: node.orientation,
        ratio: node.ratio,
        first: cloneEditorLayoutNode(node.first) ?? node.first,
        second: cloneEditorLayoutNode(node.second) ?? node.second,
    };
}

function getTabPath(tab: ITab) {
    return typeof tab.originalPath === 'string'
        ? tab.originalPath
        : null;
}

function inferDocumentKindFromName(name: string): TAgentDocumentKind {
    if (/\.djvu?$/i.test(name)) {
        return 'djvu';
    }

    if (/\.pdf$/i.test(name)) {
        return 'pdf';
    }

    if (IMAGE_EXTENSION_PATTERN.test(name)) {
        return 'image';
    }

    return name ? 'unknown' : 'empty';
}

function inferDocumentKind(
    tab: ITab,
    toolbarSnapshot: IWorkspaceToolbarSnapshot | null,
): TAgentDocumentKind {
    const path = getTabPath(tab);
    const name = tab.fileName ?? path ?? '';

    if (!name && !toolbarSnapshot?.hasPdf && !toolbarSnapshot?.isDjvuMode) {
        return 'empty';
    }

    if (tab.isDjvu || toolbarSnapshot?.isDjvuMode) {
        return 'djvu';
    }

    if (toolbarSnapshot?.hasPdf) {
        return 'pdf';
    }

    return inferDocumentKindFromName(name);
}

function buildDocumentReadiness(
    kind: TAgentDocumentKind,
    toolbarSnapshot: IWorkspaceToolbarSnapshot | null,
): IAgentDocumentReadiness {
    if (kind === 'empty') {
        return {
            status: 'empty',
            reasons: ['No document is open in this tab.'],
            recommendations: [],
        };
    }

    if (kind === 'djvu' || kind === 'image') {
        return {
            status: 'needs-preparation',
            reasons: ['Agents work best against a PDF document model with stable pages and text extraction.'],
            recommendations: [{
                id: 'convert_to_pdf',
                title: 'Convert to PDF',
                reason: kind === 'djvu'
                    ? 'DjVu documents should be converted to PDF before deeper agent analysis.'
                    : 'Image documents should be converted to PDF before deeper agent analysis.',
                toolName: 'evb.convert_to_pdf',
            }],
        };
    }

    if (kind === 'pdf') {
        const pageCount = Math.max(0, Math.floor(toolbarSnapshot?.totalPages ?? 0));
        return {
            status: 'unknown',
            reasons: ['Page-level OCR coverage is not exposed to agents yet.'],
            ocr: {
                status: 'unknown',
                pageCount,
            },
            recommendations: [{
                id: 'ocr_all_pages',
                title: 'OCR all pages',
                reason: 'If any pages lack a searchable text layer, OCRing all pages gives the agent consistent text access.',
                toolName: 'evb.ocr_all_pages',
            }],
        };
    }

    return {
        status: 'unknown',
        reasons: ['The document type is not known to the agent bridge.'],
        recommendations: [],
    };
}

function getToolbarSnapshot(workspace: IWorkspaceExpose | null) {
    if (!workspace) {
        return null;
    }

    try {
        return workspace.getToolbarSnapshot();
    } catch (error) {
        BrowserLogger.warn('agent', 'Failed to read workspace toolbar snapshot', { error: error instanceof Error ? error.message : String(error) });
        return null;
    }
}

function buildAgentTabSnapshot(
    tab: ITab,
    pane: IEditorPaneState | null,
    workspace: IWorkspaceExpose | null,
): IAgentTabSnapshot {
    const toolbarSnapshot = getToolbarSnapshot(workspace);
    const kind = inferDocumentKind(tab, toolbarSnapshot);
    return {
        tabId: tab.id,
        paneId: pane?.paneId ?? null,
        fileName: tab.fileName,
        originalPath: getTabPath(tab),
        isDirty: tab.isDirty,
        kind,
        workspaceAttached: Boolean(workspace),
        hasPdf: toolbarSnapshot?.hasPdf === true,
        isDjvu: tab.isDjvu || toolbarSnapshot?.isDjvuMode === true,
        isOpeningDocument: toolbarSnapshot?.isOpeningDocument === true,
        hasOpenError: toolbarSnapshot?.hasOpenError === true,
        currentPage: toolbarSnapshot ? toolbarSnapshot.currentPage : null,
        totalPages: toolbarSnapshot ? toolbarSnapshot.totalPages : null,
        readiness: buildDocumentReadiness(kind, toolbarSnapshot),
    };
}

function isAgentDocumentTab(tab: IAgentTabSnapshot) {
    return tab.kind !== 'empty' && Boolean(
        tab.fileName
        || tab.originalPath
        || tab.hasPdf
        || tab.isDjvu,
    );
}

function createDocumentReference(tab: IAgentTabSnapshot): IAgentDocumentReference {
    return {
        tabId: tab.tabId,
        paneId: tab.paneId,
        fileName: tab.fileName,
        originalPath: tab.originalPath,
        kind: tab.kind,
    };
}

function createRecentFileSnapshot(file: IRecentFile): IAgentRecentFileSnapshot {
    const name = file.fileName || file.originalPath;
    const openedAt = Number.isFinite(file.timestamp)
        ? new Date(file.timestamp).toISOString()
        : '';
    return {
        fileName: file.fileName,
        originalPath: file.originalPath,
        kind: inferDocumentKindFromName(name),
        openedAt,
        ...(file.fileSize === undefined ? {} : { fileSize: file.fileSize }),
    };
}

export function buildAgentWorkspaceSnapshot(
    options: Pick<
        IUseAgentWorkspaceSnapshotOptions,
        | 'panes'
        | 'tabs'
        | 'layout'
        | 'activePaneId'
        | 'activeTabId'
        | 'recentFiles'
        | 'recentFilesResolved'
        | 'workspaceRefs'
        | 'getPaneByTabId'
    >,
): IAgentWorkspaceSnapshot {
    const tabSnapshots = options.tabs.value.map(tab => buildAgentTabSnapshot(
        tab,
        options.getPaneByTabId(tab.id),
        options.workspaceRefs.value.get(tab.id) ?? null,
    ));
    const documentTabs = tabSnapshots.filter(isAgentDocumentTab);
    const activeDocumentTab = documentTabs.find(tab => tab.tabId === options.activeTabId.value) ?? null;
    const recentFiles = (options.recentFiles?.value ?? []).map(createRecentFileSnapshot);

    return {
        capturedAt: new Date().toISOString(),
        activePaneId: options.activePaneId.value,
        activeTabId: options.activeTabId.value,
        summary: {
            mode: activeDocumentTab
                ? 'open-document'
                : documentTabs.length > 0
                    ? 'documents-open-no-active-document'
                    : 'empty-workspace',
            activeDocument: activeDocumentTab ? createDocumentReference(activeDocumentTab) : null,
            documentCount: documentTabs.length,
            recentFileCount: recentFiles.length,
            recentFilesResolved: options.recentFilesResolved?.value === true,
        },
        panes: options.panes.value.map(pane => ({
            paneId: pane.paneId,
            tabIds: [...pane.tabIds],
            activeTabId: pane.activeTabId,
        })),
        tabs: tabSnapshots,
        recentFiles,
        layout: cloneEditorLayoutNode(options.layout.value),
    };
}

export function useAgentWorkspaceSnapshot(options: IUseAgentWorkspaceSnapshotOptions) {
    let unsubscribeWorkspaceSnapshotRequest: (() => void) | null = null;
    let unsubscribeCommandRequest: (() => void) | null = null;

    function createSnapshotResponse(request: IAgentWorkspaceSnapshotRequest): IAgentWorkspaceSnapshotResponse {
        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: true,
            snapshot: buildAgentWorkspaceSnapshot(options),
        };
    }

    function createCommandErrorResponse(
        request: IAgentCommandRequest,
        error: unknown,
    ): IAgentCommandResponse {
        return {
            requestId: request.requestId,
            ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    async function activateTabForAgent(tabId: string) {
        const pane = options.getPaneByTabId(tabId);
        if (!pane) {
            throw new Error(`Tab ${tabId} is not open.`);
        }

        options.activateTab(pane.paneId, tabId);
        await nextTick();
        return pane.paneId;
    }

    async function runCommand(request: IAgentCommandRequest) {
        if (request.command.name === 'activate_tab') {
            const paneId = await activateTabForAgent(request.command.arguments.tabId);
            return {
                activePaneId: paneId,
                activeTabId: request.command.arguments.tabId,
            };
        }

        const tabId = request.command.arguments.tabId ?? options.activeTabId.value;
        if (!tabId) {
            throw new Error('No active tab is available for page navigation.');
        }

        const paneId = await activateTabForAgent(tabId);
        const workspace = await options.waitForWorkspace(tabId);
        if (!workspace) {
            throw new Error(`Workspace for tab ${tabId} is not available.`);
        }

        workspace.handleGoToPage(request.command.arguments.page);
        await nextTick();
        const snapshot = workspace.getToolbarSnapshot();
        return {
            activePaneId: paneId,
            activeTabId: tabId,
            currentPage: snapshot.currentPage,
            totalPages: snapshot.totalPages,
        };
    }

    function submitSnapshot(request: IAgentWorkspaceSnapshotRequest) {
        guardAsync(getPlatformAPI().agent.submitWorkspaceSnapshot(createSnapshotResponse(request)), {
            scope: 'agent',
            message: 'Failed to submit agent workspace snapshot',
        });
    }

    function submitCommandResult(request: IAgentCommandRequest) {
        guardAsync(
            runCommand(request)
                .then(result => getPlatformAPI().agent.submitCommandResponse({
                    requestId: request.requestId,
                    ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
                    ok: true,
                    result,
                }))
                .catch(error => getPlatformAPI().agent.submitCommandResponse(
                    createCommandErrorResponse(request, error),
                )),
            {
                scope: 'agent',
                message: 'Failed to submit agent command response',
            },
        );
    }

    onMounted(() => {
        guardAsync(
            (async () => {
                await waitForDesktopPlatformBridge({ shouldWait: options.shouldWaitForDesktopBridge() });
                const platform = getPlatformAPI();
                unsubscribeWorkspaceSnapshotRequest = platform.agent.onWorkspaceSnapshotRequest(submitSnapshot);
                unsubscribeCommandRequest = platform.agent.onCommandRequest(submitCommandResult);
            })(),
            {
                scope: 'agent',
                message: 'Failed to attach agent workspace bridge',
            },
        );
    });

    onUnmounted(() => {
        unsubscribeWorkspaceSnapshotRequest?.();
        unsubscribeWorkspaceSnapshotRequest = null;
        unsubscribeCommandRequest?.();
        unsubscribeCommandRequest = null;
    });

    return { buildSnapshot: () => buildAgentWorkspaceSnapshot(options) };
}
