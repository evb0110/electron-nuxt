import type { ITab } from '@app/types/tabs';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@app/types/editorPanes';
import {
    appendPaneToLayout,
    collectLayoutPaneIds,
    pruneLayoutToExistingPanes,
} from '@app/modules/workspace-shell/composables/editor-panes/layoutTree';

interface IEditorPanesStateSnapshot {
    panes: IEditorPaneState[];
    tabs: ITab[];
    layout: TEditorLayoutNode | null;
    activePaneId: string | null;
    paneMru: string[];
}

interface INormalizeEditorPanesStateParams extends IEditorPanesStateSnapshot { createPane: () => IEditorPaneState; }

interface IUniqueTabsResult {
    tabs: ITab[];
    tabIds: Set<string>;
    hasInvalidTabs: boolean;
}

interface INormalizedPanesResult {
    panes: IEditorPaneState[];
    paneIds: Set<string>;
    assignedTabIds: Set<string>;
    hasInvalidPanes: boolean;
}

interface IActivePaneMruResult {
    activePaneId: string | null;
    paneMru: string[];
}

function readPaneId(pane: IEditorPaneState) {
    const rawPane = pane as IEditorPaneState & { id?: unknown };
    if (typeof rawPane.paneId === 'string' && rawPane.paneId.length > 0) {
        return rawPane.paneId;
    }
    return typeof rawPane.id === 'string' ? rawPane.id : '';
}

export function arraysEqual<T>(left: T[], right: T[]) {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function buildNormalizedPaneMru(
    currentActivePaneId: string | null,
    currentMru: string[],
    panesOrder: string[],
    validPaneIds: Set<string>,
) {
    const nextMru: string[] = [];
    const mruSeen = new Set<string>();
    const preferredPaneIds = [
        currentActivePaneId,
        ...currentMru,
        ...panesOrder,
    ];
    for (const paneId of preferredPaneIds) {
        if (!paneId || !validPaneIds.has(paneId) || mruSeen.has(paneId)) {
            continue;
        }
        mruSeen.add(paneId);
        nextMru.push(paneId);
    }
    return nextMru;
}

function collectUniqueTabs(tabs: ITab[]): IUniqueTabsResult {
    const uniqueTabs: ITab[] = [];
    const validTabIds = new Set<string>();
    let hasInvalidTabs = false;

    for (const tab of tabs) {
        if (!tab.id || validTabIds.has(tab.id)) {
            hasInvalidTabs = true;
            continue;
        }
        validTabIds.add(tab.id);
        uniqueTabs.push(tab);
    }

    return {
        tabs: uniqueTabs,
        tabIds: validTabIds,
        hasInvalidTabs,
    };
}

function normalizePaneTabIds(
    panes: IEditorPaneState[],
    validTabIds: Set<string>,
): INormalizedPanesResult {
    const normalizedPanes: IEditorPaneState[] = [];
    const validPaneIds = new Set<string>();
    const assignedTabIds = new Set<string>();
    let hasInvalidPanes = false;

    for (const pane of panes) {
        const paneId = readPaneId(pane);
        if (!paneId || validPaneIds.has(paneId)) {
            hasInvalidPanes = true;
            continue;
        }
        hasInvalidPanes ||= pane.paneId !== paneId;
        validPaneIds.add(paneId);

        const nextTabIds: string[] = [];
        for (const tabId of pane.tabIds) {
            if (!validTabIds.has(tabId) || assignedTabIds.has(tabId)) {
                hasInvalidPanes = true;
                continue;
            }
            assignedTabIds.add(tabId);
            nextTabIds.push(tabId);
        }

        const activeTabId = pane.activeTabId && nextTabIds.includes(pane.activeTabId)
            ? pane.activeTabId
            : (nextTabIds[0] ?? null);
        hasInvalidPanes ||= pane.activeTabId !== activeTabId;
        normalizedPanes.push({
            paneId,
            tabIds: nextTabIds,
            activeTabId,
        });
    }

    return {
        panes: normalizedPanes,
        paneIds: validPaneIds,
        assignedTabIds,
        hasInvalidPanes,
    };
}

function normalizeLayoutForPanes(
    layout: TEditorLayoutNode | null,
    panes: IEditorPaneState[],
    validPaneIds: Set<string>,
): TEditorLayoutNode {
    let nextLayout = layout ? pruneLayoutToExistingPanes(layout, validPaneIds) : null;
    if (!nextLayout) {
        nextLayout = {
            type: 'leaf',
            paneId: panes[0]!.paneId,
        };
    }

    const layoutPaneIds = new Set<string>();
    collectLayoutPaneIds(nextLayout, layoutPaneIds);
    for (const pane of panes) {
        if (layoutPaneIds.has(pane.paneId)) {
            continue;
        }
        nextLayout = appendPaneToLayout(nextLayout, pane.paneId);
        layoutPaneIds.add(pane.paneId);
    }

    return nextLayout;
}

function layoutMatchesPanes(layout: TEditorLayoutNode | null, validPaneIds: Set<string>) {
    if (!layout) {
        return false;
    }
    const layoutPaneIds = new Set<string>();
    collectLayoutPaneIds(layout, layoutPaneIds);
    for (const paneId of layoutPaneIds) {
        if (!validPaneIds.has(paneId)) {
            return false;
        }
    }
    for (const paneId of validPaneIds) {
        if (!layoutPaneIds.has(paneId)) {
            return false;
        }
    }

    return true;
}

function normalizeActivePaneAndMru(
    activePaneId: string | null,
    paneMru: string[],
    panes: IEditorPaneState[],
    validPaneIds: Set<string>,
): IActivePaneMruResult {
    const nextActivePaneId = activePaneId && validPaneIds.has(activePaneId)
        ? activePaneId
        : (panes[0]?.paneId ?? null);
    const nextMru = buildNormalizedPaneMru(
        nextActivePaneId,
        paneMru,
        panes.map(pane => pane.paneId),
        validPaneIds,
    );

    return {
        activePaneId: nextActivePaneId,
        paneMru: nextMru,
    };
}

function clonePanesWithUnassignedTabs(
    panes: IEditorPaneState[],
    tabs: ITab[],
    assignedTabIds: Set<string>,
) {
    const nextPanes = panes.map(pane => ({
        ...pane,
        tabIds: [...pane.tabIds],
    }));
    const fallbackPane = nextPanes[0]!;

    for (const tab of tabs) {
        if (assignedTabIds.has(tab.id)) {
            continue;
        }
        fallbackPane.tabIds.push(tab.id);
        assignedTabIds.add(tab.id);
    }

    for (const pane of nextPanes) {
        pane.activeTabId = pane.activeTabId && pane.tabIds.includes(pane.activeTabId)
            ? pane.activeTabId
            : (pane.tabIds[0] ?? null);
    }

    return nextPanes;
}

export function isEditorPanesStateNormalized(state: IEditorPanesStateSnapshot) {
    const tabs = collectUniqueTabs(state.tabs);
    if (tabs.hasInvalidTabs || tabs.tabs.length !== state.tabs.length) {
        return false;
    }

    if (state.panes.length === 0) {
        return false;
    }

    const panes = normalizePaneTabIds(state.panes, tabs.tabIds);
    if (
        panes.hasInvalidPanes
        || panes.assignedTabIds.size !== tabs.tabIds.size
        || panes.panes.length !== state.panes.length
    ) {
        return false;
    }

    if (!layoutMatchesPanes(state.layout, panes.paneIds)) {
        return false;
    }

    if (!state.activePaneId || !panes.paneIds.has(state.activePaneId)) {
        return false;
    }

    const nextMru = normalizeActivePaneAndMru(
        state.activePaneId,
        state.paneMru,
        panes.panes,
        panes.paneIds,
    ).paneMru;
    return arraysEqual(state.paneMru, nextMru);
}

export function normalizeEditorPanesState({
    panes,
    tabs,
    layout,
    activePaneId,
    paneMru,
    createPane,
}: INormalizeEditorPanesStateParams): IEditorPanesStateSnapshot {
    const uniqueTabs = collectUniqueTabs(tabs);
    const normalizedPanes = normalizePaneTabIds(panes, uniqueTabs.tabIds);

    if (normalizedPanes.panes.length === 0) {
        const fallbackPane = createPane();
        normalizedPanes.panes.push(fallbackPane);
        normalizedPanes.paneIds.add(fallbackPane.paneId);
    }

    const nextPanes = clonePanesWithUnassignedTabs(
        normalizedPanes.panes,
        uniqueTabs.tabs,
        normalizedPanes.assignedTabIds,
    );
    const freshPaneIds = new Set(nextPanes.map(pane => pane.paneId));
    const nextLayout = normalizeLayoutForPanes(layout, nextPanes, freshPaneIds);
    const activePaneMru = normalizeActivePaneAndMru(
        activePaneId,
        paneMru,
        nextPanes,
        freshPaneIds,
    );

    return {
        panes: nextPanes,
        tabs: uniqueTabs.tabs,
        layout: nextLayout,
        activePaneId: activePaneMru.activePaneId,
        paneMru: activePaneMru.paneMru,
    };
}
