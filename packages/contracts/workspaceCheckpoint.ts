import type { TEditorLayoutNode } from '@contracts/editorPanes';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';

export type TWorkspaceCheckpointSurfaceMode = 'reader' | 'scan-cleanup';

export interface IWorkspaceCheckpointTab {
    tabId: string;
    paneId: string | null;
    fileName: string | null;
    sourceRef: TDocumentRef | null;
    workingCopyRef: TDocumentRef | null;
    requiresSaveAsOnFirstSave?: boolean;
    isDirty: boolean;
    isDjvu: boolean;
    currentPage: number | null;
    zoom: number | null;
    zoomMode: TZoomMode | null;
    continuousScroll?: boolean | null;
    viewMode?: TPdfViewMode | null;
    viewRotation?: TPdfViewRotation | null;
    /** Persist only the active surface. Large scan-cleanup state stays file-backed. */
    surfaceMode?: TWorkspaceCheckpointSurfaceMode;
}

export interface IWorkspaceCheckpointPane {
    paneId: string;
    tabIds: string[];
    activeTabId: string | null;
}

export interface IWorkspaceCheckpoint {
    version: 1;
    capturedAt: number;
    activePaneId: string | null;
    activeTabId: string | null;
    layout: TEditorLayoutNode | null;
    panes: IWorkspaceCheckpointPane[];
    tabs: IWorkspaceCheckpointTab[];
}

const ZOOM_MODES = new Set<TZoomMode>([
    'custom',
    'fit-height',
    'fit-width',
]);
const VIEW_MODES = new Set<TPdfViewMode>([
    'single',
    'facing',
    'facing-first-single',
]);
const VIEW_ROTATIONS = new Set<TPdfViewRotation>([
    0,
    90,
    180,
    270,
]);

function decodeNullableString(value: unknown) {
    return value === null || typeof value === 'string' ? value : undefined;
}

function decodeLayout(value: unknown, depth = 0): TEditorLayoutNode | null | undefined {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || depth > 16) {
        return undefined;
    }
    if (value.type === 'leaf' && typeof value.paneId === 'string') {
        return {
            type: 'leaf',
            paneId: value.paneId,
        };
    }
    if (
        value.type !== 'split'
        || typeof value.id !== 'string'
        || (value.orientation !== 'horizontal' && value.orientation !== 'vertical')
        || typeof value.ratio !== 'number'
        || !Number.isFinite(value.ratio)
    ) {
        return undefined;
    }
    const first = decodeLayout(value.first, depth + 1);
    const second = decodeLayout(value.second, depth + 1);
    if (!first || !second) {
        return undefined;
    }
    return {
        type: 'split',
        id: value.id,
        orientation: value.orientation,
        ratio: value.ratio,
        first,
        second,
    };
}

export function decodeWorkspaceCheckpoint(value: unknown): IWorkspaceCheckpoint | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || typeof value.capturedAt !== 'number'
        || !Number.isFinite(value.capturedAt)
        || !Array.isArray(value.panes)
        || value.panes.length > 32
        || !Array.isArray(value.tabs)
        || value.tabs.length > 128
    ) {
        return null;
    }
    const activePaneId = decodeNullableString(value.activePaneId);
    const activeTabId = decodeNullableString(value.activeTabId);
    const layout = decodeLayout(value.layout);
    if (activePaneId === undefined || activeTabId === undefined || layout === undefined) {
        return null;
    }
    const panes: IWorkspaceCheckpointPane[] = [];
    for (const candidate of value.panes) {
        if (!isRecord(candidate) || typeof candidate.paneId !== 'string' || !Array.isArray(candidate.tabIds)
            || candidate.tabIds.some(tabId => typeof tabId !== 'string')) {
            return null;
        }
        const paneActiveTabId = decodeNullableString(candidate.activeTabId);
        if (paneActiveTabId === undefined) {
            return null;
        }
        panes.push({
            paneId: candidate.paneId,
            tabIds: candidate.tabIds.map(tabId => String(tabId)),
            activeTabId: paneActiveTabId,
        });
    }
    const tabs: IWorkspaceCheckpointTab[] = [];
    for (const candidate of value.tabs) {
        if (!isRecord(candidate)) {
            return null;
        }
        const paneId = decodeNullableString(candidate.paneId);
        const fileName = decodeNullableString(candidate.fileName);
        const sourceRef = decodeNullableString(candidate.sourceRef);
        const workingCopyRef = decodeNullableString(candidate.workingCopyRef);
        const requiresSaveAsOnFirstSave = candidate.requiresSaveAsOnFirstSave === undefined
            ? undefined
            : typeof candidate.requiresSaveAsOnFirstSave === 'boolean'
                ? candidate.requiresSaveAsOnFirstSave
                : null;
        const currentPage = candidate.currentPage === null ? null
            : typeof candidate.currentPage === 'number' && Number.isSafeInteger(candidate.currentPage) && candidate.currentPage > 0
                ? candidate.currentPage : undefined;
        const zoom = candidate.zoom === null ? null
            : typeof candidate.zoom === 'number' && Number.isFinite(candidate.zoom) && candidate.zoom > 0
                ? candidate.zoom : undefined;
        const zoomMode = candidate.zoomMode === null ? null
            : typeof candidate.zoomMode === 'string' && ZOOM_MODES.has(candidate.zoomMode as TZoomMode)
                ? candidate.zoomMode as TZoomMode : undefined;
        const continuousScroll = candidate.continuousScroll === undefined
            ? undefined
            : candidate.continuousScroll === null ? null
                : typeof candidate.continuousScroll === 'boolean' ? candidate.continuousScroll : undefined;
        const viewMode = candidate.viewMode === undefined
            ? undefined
            : candidate.viewMode === null ? null
                : typeof candidate.viewMode === 'string' && VIEW_MODES.has(candidate.viewMode as TPdfViewMode)
                    ? candidate.viewMode as TPdfViewMode : undefined;
        const viewRotation = candidate.viewRotation === undefined
            ? undefined
            : candidate.viewRotation === null ? null
                : typeof candidate.viewRotation === 'number'
                    && Number.isSafeInteger(candidate.viewRotation)
                    && VIEW_ROTATIONS.has(candidate.viewRotation as TPdfViewRotation)
                    ? candidate.viewRotation as TPdfViewRotation : undefined;
        const surfaceMode: TWorkspaceCheckpointSurfaceMode | null | undefined = candidate.surfaceMode === undefined
            ? undefined
            : candidate.surfaceMode === 'reader' || candidate.surfaceMode === 'scan-cleanup'
                ? candidate.surfaceMode
                : null;
        if (typeof candidate.tabId !== 'string' || paneId === undefined || fileName === undefined
            || sourceRef === undefined || workingCopyRef === undefined || typeof candidate.isDirty !== 'boolean'
            || requiresSaveAsOnFirstSave === null
            || typeof candidate.isDjvu !== 'boolean' || currentPage === undefined || zoom === undefined || zoomMode === undefined
            || (candidate.continuousScroll !== undefined && continuousScroll === undefined)
            || (candidate.viewMode !== undefined && viewMode === undefined)
            || (candidate.viewRotation !== undefined && viewRotation === undefined)
            || (candidate.surfaceMode !== undefined && surfaceMode === null)) {
            return null;
        }
        tabs.push({
            tabId: candidate.tabId,
            paneId,
            fileName,
            sourceRef,
            workingCopyRef,
            ...(requiresSaveAsOnFirstSave === undefined ? {} : {requiresSaveAsOnFirstSave}),
            isDirty: candidate.isDirty,
            isDjvu: candidate.isDjvu,
            currentPage,
            zoom,
            zoomMode,
            ...(continuousScroll === undefined ? {} : {continuousScroll}),
            ...(viewMode === undefined ? {} : {viewMode}),
            ...(viewRotation === undefined ? {} : {viewRotation}),
            ...(surfaceMode === undefined || surfaceMode === null ? {} : {surfaceMode}),
        });
    }
    return {
        version: 1,
        capturedAt: value.capturedAt,
        activePaneId,
        activeTabId,
        layout,
        panes,
        tabs,
    };
}
