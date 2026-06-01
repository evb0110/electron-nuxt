import type { ITab } from '@app/types/tabs';
import { keyBy } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import type {
    IEditorPaneState,
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TPaneDirection,
} from '@app/types/editorPanes';
import {
    removeLeafNode,
    replaceLeafWithSplit,
    updateLayoutSplitRatio,
} from '@app/modules/workspace-shell/composables/editor-panes/layoutTree';
import { findDirectionalPaneId } from '@app/modules/workspace-shell/composables/editor-panes/navigation';
import {
    arraysEqual,
    isEditorPanesStateNormalized,
    normalizeEditorPanesState,
} from '@app/modules/workspace-shell/composables/editor-panes/normalization';

interface ICreateTabOptions {
    paneId?: string | null;
    initial?: Partial<Pick<ITab, 'fileName' | 'originalPath' | 'isDirty' | 'isDjvu'>>;
    activate?: boolean;
}

interface ICloseTabResult {
    tab: ITab | null;
    removedPaneId: string | null;
}

export const useEditorPanesManager = () => {
    const panes = useState<IEditorPaneState[]>(
        'editorPanes:panes',
        () => [],
    );
    const tabs = useState<ITab[]>(
        'editorPanes:tabs',
        () => [],
    );
    const layout = useState<TEditorLayoutNode | null>(
        'editorPanes:layout',
        () => null,
    );
    const activePaneId = useState<string | null>(
        'editorPanes:active-pane-id',
        () => null,
    );
    const paneMru = useState<string[]>(
        'editorPanes:pane-mru',
        () => [],
    );
    const nextEntityId = useState<number>(
        'editorPanes:entity-id',
        () => 0,
    );

    function allocateEntityId(prefix: 'pane' | 'tab' | 'split') {
        nextEntityId.value += 1;
        return `${prefix}-${nextEntityId.value.toString(36)}`;
    }

    const paneLookup = computed(() => {
        return new Map(Object.entries(keyBy(panes.value, pane => pane.id)));
    });
    const tabLookup = computed(() => {
        return new Map(Object.entries(keyBy(tabs.value, tab => tab.id)));
    });
    const tabPaneLookup = computed(() => {
        return new Map(panes.value.flatMap(pane => pane.tabIds.map(tabId => [
            tabId,
            pane.id,
        ])));
    });

    function createPane(): IEditorPaneState {
        return {
            id: allocateEntityId('pane'),
            tabIds: [],
            activeTabId: null,
        };
    }

    function withPaneUpdate(
        paneId: string,
        update: (pane: IEditorPaneState) => IEditorPaneState,
    ) {
        panes.value = panes.value.map(pane => (
            pane.id === paneId ? update(pane) : pane
        ));
        return getPaneById(paneId);
    }

    function setPaneActiveTab(paneId: string, activeTabIdValue: string | null) {
        return withPaneUpdate(paneId, pane => ({
            ...pane,
            activeTabId: activeTabIdValue,
        }));
    }

    function updatePaneTabIds(
        paneId: string,
        update: (tabIds: string[]) => string[],
        activeTabIdUpdate?: (pane: IEditorPaneState, nextTabIds: string[]) => string | null,
    ) {
        return withPaneUpdate(paneId, (pane) => {
            const nextTabIds = update(pane.tabIds);
            return {
                ...pane,
                tabIds: nextTabIds,
                activeTabId: activeTabIdUpdate
                    ? activeTabIdUpdate(pane, nextTabIds)
                    : pane.activeTabId,
            };
        });
    }

    function isManagerStateNormalized() {
        return isEditorPanesStateNormalized({
            panes: panes.value,
            tabs: tabs.value,
            layout: layout.value,
            activePaneId: activePaneId.value,
            paneMru: paneMru.value,
        });
    }

    function normalizeManagerState() {
        if (isManagerStateNormalized()) {
            return;
        }
        const nextState = normalizeEditorPanesState({
            panes: panes.value,
            tabs: tabs.value,
            layout: layout.value,
            activePaneId: activePaneId.value,
            paneMru: paneMru.value,
            createPane,
        });
        tabs.value = nextState.tabs;
        panes.value = nextState.panes;
        layout.value = nextState.layout;
        activePaneId.value = nextState.activePaneId;
        paneMru.value = nextState.paneMru;
    }

    function createEmptyTab(initial?: ICreateTabOptions['initial']): ITab {
        return {
            id: allocateEntityId('tab'),
            fileName: initial?.fileName ?? null,
            originalPath: initial?.originalPath ?? null,
            isDirty: initial?.isDirty ?? false,
            isDjvu: initial?.isDjvu ?? false,
        };
    }

    function touchPaneMru(paneId: string) {
        if (
            paneMru.value[0] === paneId
            && paneMru.value.indexOf(paneId, 1) === -1
        ) {
            return;
        }
        const next = paneMru.value.filter(candidate => candidate !== paneId);
        next.unshift(paneId);
        if (!arraysEqual(paneMru.value, next)) {
            paneMru.value = next;
        }
    }

    function getPaneById(id: string | null | undefined) {
        if (!id) {
            return null;
        }
        return paneLookup.value.get(id) ?? null;
    }

    function getTabById(id: string | null | undefined) {
        if (!id) {
            return null;
        }
        return tabLookup.value.get(id) ?? null;
    }

    function getPaneByTabId(tabId: string) {
        const paneId = tabPaneLookup.value.get(tabId);
        return paneId ? getPaneById(paneId) : null;
    }

    function getPaneTabs(paneId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return [];
        }
        return pane.tabIds
            .map(tabId => getTabById(tabId))
            .filter((tab): tab is ITab => Boolean(tab));
    }

    function ensureLayoutInitialized() {
        if (layout.value && panes.value.length > 0) {
            return;
        }

        const pane = createPane();
        panes.value = [pane];
        activePaneId.value = pane.id;
        paneMru.value = [pane.id];
        layout.value = {
            type: 'leaf',
            paneId: pane.id,
        };
        normalizeManagerState();
    }

    function ensureAtLeastOneTab() {
        normalizeManagerState();
        ensureLayoutInitialized();

        const hasAnyTab = panes.value.some(pane => pane.tabIds.length > 0);
        if (hasAnyTab) {
            const activePane = getPaneById(activePaneId.value) ?? panes.value[0] ?? null;
            if (activePane) {
                activePaneId.value = activePane.id;
                touchPaneMru(activePane.id);
                if (!activePane.activeTabId && activePane.tabIds.length > 0) {
                    setPaneActiveTab(activePane.id, activePane.tabIds[0] ?? null);
                }
            }
            normalizeManagerState();
            return;
        }

        createTab({
            paneId: activePaneId.value,
            activate: true,
        });
        normalizeManagerState();
    }

    function activatePane(paneId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }

        activePaneId.value = pane.id;
        touchPaneMru(pane.id);

        if (!pane.activeTabId && pane.tabIds.length > 0) {
            setPaneActiveTab(pane.id, pane.tabIds[0] ?? null);
        }
        normalizeManagerState();
    }

    function activateTab(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        if (!pane || !pane.tabIds.includes(tabId)) {
            return;
        }

        setPaneActiveTab(paneId, tabId);
        activatePane(paneId);
        normalizeManagerState();
    }

    function createTab(options: ICreateTabOptions = {}) {
        normalizeManagerState();
        ensureLayoutInitialized();

        let pane = getPaneById(options.paneId ?? activePaneId.value);
        if (!pane) {
            pane = panes.value[0] ?? null;
        }
        if (!pane) {
            pane = createPane();
            panes.value = [
                ...panes.value,
                pane,
            ];
            if (!layout.value) {
                layout.value = {
                    type: 'leaf',
                    paneId: pane.id,
                };
            }
        }

        const tab = createEmptyTab(options.initial);
        tabs.value = [
            ...tabs.value,
            tab,
        ];

        updatePaneTabIds(
            pane.id,
            tabIds => [
                ...tabIds,
                tab.id,
            ],
            currentPane => options.activate !== false || !currentPane.activeTabId
                ? tab.id
                : currentPane.activeTabId,
        );

        if (options.activate !== false) {
            activatePane(pane.id);
        }

        normalizeManagerState();
        return tab;
    }

    function moveTabWithinPane(paneId: string, fromIndex: number, toIndex: number) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }

        if (
            fromIndex < 0
            || fromIndex >= pane.tabIds.length
            || toIndex < 0
            || toIndex >= pane.tabIds.length
            || fromIndex === toIndex
        ) {
            return;
        }

        const tabId = pane.tabIds[fromIndex];
        if (!tabId) {
            return;
        }
        updatePaneTabIds(paneId, (tabIds) => {
            const withoutMoved = tabIds.filter((_, index) => index !== fromIndex);
            return [
                ...withoutMoved.slice(0, toIndex),
                tabId,
                ...withoutMoved.slice(toIndex),
            ];
        });
        normalizeManagerState();
    }

    function closePane(paneId: string) {
        if (panes.value.length <= 1) {
            return false;
        }

        const pane = getPaneById(paneId);
        if (!pane) {
            return false;
        }

        panes.value = panes.value.filter(candidate => candidate.id !== pane.id);
        paneMru.value = paneMru.value.filter(candidate => candidate !== pane.id);

        if (layout.value) {
            layout.value = removeLeafNode(layout.value, pane.id);
        }

        const nextActivePane = getPaneById(activePaneId.value)
            ?? paneMru.value.map(id => getPaneById(id)).find((candidate): candidate is IEditorPaneState => Boolean(candidate))
            ?? panes.value[0]
            ?? null;

        activePaneId.value = nextActivePane?.id ?? null;
        if (nextActivePane) {
            touchPaneMru(nextActivePane.id);
            if (!nextActivePane.activeTabId && nextActivePane.tabIds.length > 0) {
                setPaneActiveTab(nextActivePane.id, nextActivePane.tabIds[0] ?? null);
            }
        }

        normalizeManagerState();
        return true;
    }

    function closeTab(paneId: string, tabId: string): ICloseTabResult {
        const pane = getPaneById(paneId);
        if (!pane) {
            return {
                tab: null,
                removedPaneId: null,
            };
        }

        const tabIndex = pane.tabIds.findIndex(candidate => candidate === tabId);
        if (tabIndex === -1) {
            return {
                tab: null,
                removedPaneId: null,
            };
        }

        const tab = getTabById(tabId);
        const nextTabIds = pane.tabIds.filter(candidate => candidate !== tabId);
        tabs.value = tabs.value.filter(candidate => candidate.id !== tabId);

        const replacement = nextTabIds[tabIndex] ?? nextTabIds[tabIndex - 1] ?? null;
        updatePaneTabIds(
            pane.id,
            () => nextTabIds,
            currentPane => currentPane.activeTabId === tabId ? replacement : currentPane.activeTabId,
        );

        let removedPaneId: string | null = null;
        if (nextTabIds.length === 0) {
            if (panes.value.length > 1) {
                removedPaneId = pane.id;
                closePane(pane.id);
            } else {
                const replacement = createTab({
                    paneId: pane.id,
                    activate: true,
                });
                setPaneActiveTab(pane.id, replacement.id);
            }
        }

        normalizeManagerState();
        return {
            tab,
            removedPaneId,
        };
    }

    function findDirectionalPane(
        sourcePaneId: string,
        direction: TPaneDirection,
        wrap = true,
    ) {
        const targetPaneId = findDirectionalPaneId({
            layout: layout.value,
            sourcePaneId,
            direction,
            paneMru: paneMru.value,
            wrap,
        });
        return targetPaneId ? getPaneById(targetPaneId) : null;
    }

    function splitPane(sourcePaneId: string, direction: TPaneDirection) {
        const sourcePane = getPaneById(sourcePaneId);
        if (!sourcePane || !layout.value) {
            return null;
        }

        const newPane = createPane();
        panes.value = [
            ...panes.value,
            newPane,
        ];

        const sourceLeaf: IEditorLayoutLeafNode = {
            type: 'leaf',
            paneId: sourcePaneId,
        };
        const newLeaf: IEditorLayoutLeafNode = {
            type: 'leaf',
            paneId: newPane.id,
        };

        const horizontal = direction === 'left' || direction === 'right';
        const beforeSource = direction === 'left' || direction === 'up';

        const splitNode: IEditorLayoutSplitNode = {
            type: 'split',
            id: allocateEntityId('split'),
            orientation: horizontal ? 'horizontal' : 'vertical',
            ratio: 0.5,
            first: beforeSource ? newLeaf : sourceLeaf,
            second: beforeSource ? sourceLeaf : newLeaf,
        };

        layout.value = replaceLeafWithSplit(layout.value, sourcePaneId, splitNode);
        touchPaneMru(newPane.id);
        normalizeManagerState();

        return newPane.id;
    }

    function setSplitRatio(splitId: string, nextRatio: number) {
        const clamped = clamp(nextRatio, 0.15, 0.85);

        if (!layout.value) {
            return;
        }

        layout.value = updateLayoutSplitRatio(layout.value, splitId, clamped);
        normalizeManagerState();
    }

    function focusPane(direction: TPaneDirection, wrap = true) {
        const sourcePane = getPaneById(activePaneId.value) ?? panes.value[0] ?? null;
        if (!sourcePane) {
            return null;
        }

        const target = findDirectionalPane(sourcePane.id, direction, wrap);
        if (!target) {
            return null;
        }

        activatePane(target.id);
        return target.id;
    }

    function moveTabToPane(tabId: string, targetPaneId: string, activate = true) {
        const sourcePane = getPaneByTabId(tabId);
        const targetPane = getPaneById(targetPaneId);
        if (!sourcePane || !targetPane) {
            return false;
        }

        if (sourcePane.id === targetPane.id) {
            if (activate) {
                activateTab(targetPane.id, tabId);
            }
            normalizeManagerState();
            return true;
        }

        const nextSourceTabIds = sourcePane.tabIds.filter(candidate => candidate !== tabId);
        updatePaneTabIds(
            sourcePane.id,
            () => nextSourceTabIds,
            currentPane => currentPane.activeTabId === tabId
                ? nextSourceTabIds[nextSourceTabIds.length - 1] ?? null
                : currentPane.activeTabId,
        );
        updatePaneTabIds(
            targetPane.id,
            tabIds => [
                ...tabIds,
                tabId,
            ],
            () => tabId,
        );

        if (nextSourceTabIds.length === 0) {
            closePane(sourcePane.id);
        }

        if (activate) {
            activateTab(targetPane.id, tabId);
        }

        normalizeManagerState();
        return true;
    }

    function copyTabToPane(tabId: string, targetPaneId: string, activate = true) {
        const sourceTab = getTabById(tabId);
        const targetPane = getPaneById(targetPaneId);
        if (!sourceTab || !targetPane) {
            return null;
        }

        const copied = createTab({
            paneId: targetPane.id,
            activate,
            initial: {
                fileName: sourceTab.fileName,
                originalPath: sourceTab.originalPath,
                isDirty: sourceTab.isDirty,
                isDjvu: sourceTab.isDjvu,
            },
        });

        return copied;
    }

    function ensureTargetPaneForDirection(sourcePaneId: string, direction: TPaneDirection) {
        const existing = findDirectionalPane(sourcePaneId, direction, false);
        if (existing) {
            return {
                pane: existing,
                created: false,
            };
        }

        const paneId = splitPane(sourcePaneId, direction);
        const pane = getPaneById(paneId);
        if (!pane) {
            return null;
        }

        return {
            pane,
            created: true,
        };
    }

    function moveActiveTabToDirection(direction: TPaneDirection) {
        const sourcePane = getPaneById(activePaneId.value);
        if (!sourcePane || !sourcePane.activeTabId) {
            return null;
        }
        const sourceTabId = sourcePane.activeTabId;

        const target = ensureTargetPaneForDirection(sourcePane.id, direction);
        if (!target) {
            return null;
        }

        const moved = moveTabToPane(sourceTabId, target.pane.id, true);
        if (!moved) {
            return null;
        }

        return {
            tabId: sourceTabId,
            targetPaneId: target.pane.id,
            createdPane: target.created,
        };
    }

    function copyActiveTabToDirection(direction: TPaneDirection) {
        const sourcePane = getPaneById(activePaneId.value);
        if (!sourcePane || !sourcePane.activeTabId) {
            return null;
        }

        const target = ensureTargetPaneForDirection(sourcePane.id, direction);
        if (!target) {
            return null;
        }

        const copied = copyTabToPane(sourcePane.activeTabId, target.pane.id, true);
        if (!copied) {
            return null;
        }

        return {
            sourceTabId: sourcePane.activeTabId,
            targetTabId: copied.id,
            targetPaneId: target.pane.id,
            createdPane: target.created,
        };
    }

    const activePane = computed(() => getPaneById(activePaneId.value));
    const activeTabId = computed(() => activePane.value?.activeTabId ?? null);

    ensureAtLeastOneTab();

    return {
        panes,
        tabs,
        layout,
        activePaneId,
        activePane,
        activeTabId,
        ensureAtLeastOneTab,
        getPaneById,
        getTabById,
        getPaneByTabId,
        getPaneTabs,
        activatePane,
        activateTab,
        createTab,
        closeTab,
        moveTabWithinPane,
        splitPane,
        closePane,
        setSplitRatio,
        focusPane,
        findDirectionalPane,
        moveTabToPane,
        copyTabToPane,
        moveActiveTabToDirection,
        copyActiveTabToDirection,
    };
};
