<template>
    <div
        v-if="leafNode"
        class="editor-pane"
        :class="{
            'is-active': leafNode.paneId === activePaneId,
            'has-multiple-panes': hasMultiplePanes,
        }"
        @pointerdown="handlePanePointerDown(leafNode.paneId)"
    >
        <template v-if="paneForLeaf">
            <TabBar
                v-if="!zenMode"
                :tabs="tabsForPane(paneForLeaf!.paneId)"
                :active-tab-id="paneForLeaf!.activeTabId"
                :context-availability="tabContextAvailabilityByPane[paneForLeaf!.paneId] ?? null"
                @activate="handleLeafTabActivate"
                @close="handleLeafTabClose"
                @new-tab="handleLeafNewTab"
                @reorder="handleLeafTabReorder"
                @move-direction="handleLeafTabMoveDirection"
                @tab-context-command="handleLeafTabContextCommand"
            />
            <div class="editor-pane-content">
                <template v-for="tab in tabsForPane(paneForLeaf!.paneId)" :key="tab.id">
                    <DeferredDocumentWorkspaceHost
                        v-if="shouldMountHost(tab.id)"
                        v-show="tab.id === paneForLeaf!.activeTabId"
                        :tab-id="tab.id"
                        :document-path="tab.originalPath"
                        :document-record="documentRecordsByTabId[tab.id] ?? null"
                        :has-document-hint="tabHasDocumentHint(tab)"
                        :initial-view-state="viewStateByTabId[tab.id] ?? null"
                        :document-session="documentSessionsByTabId[tab.id] ?? null"
                        :is-startup-open-claim-pending="isStartupOpenClaimPending"
                        :is-active="paneForLeaf!.paneId === activePaneId && tab.id === paneForLeaf!.activeTabId"
                        :is-render-active="tab.id === paneForLeaf!.activeTabId"
                        :is-tab-transition-busy="isTabTransitionBusy"
                        :is-fullscreen="isFullscreen"
                        :fullscreen-supported="fullscreenSupported"
                        :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                        :start-section="startSectionByTabId[tab.id] ?? 'recent'"
                        @update-document-record="handleWorkspaceDocumentRecordUpdate(tab.id, $event)"
                        @update-session-state="handleWorkspaceSessionStateUpdate(tab.id, $event)"
                        @update:start-section="handleWorkspaceStartSectionUpdate(tab.id, $event)"
                        @open-in-new-tab="handleLeafOpenInNewTab"
                        @request-close-tab="handleLeafRequestCloseTab(tab.id)"
                        @open-settings="handleOpenSettings"
                        @open-combine="handleOpenCombine"
                        @toggle-fullscreen="handleToggleFullscreen"
                        @expose-ready="handleWorkspaceExposeReady(tab.id, $event)"
                        @expose-released="handleWorkspaceExposeReleased(tab.id)"
                    />
                </template>
            </div>
        </template>
        <div v-else class="editor-pane-content" />
    </div>

    <div
        v-else-if="splitNode"
        ref="splitContainerRef"
        class="editor-split"
        :class="[
            splitNode.orientation === 'horizontal' ? 'is-horizontal' : 'is-vertical',
            {'is-ultra-compact': splitRatioBounds.ultraCompact},
        ]"
    >
        <div
            v-if="!zenMode || firstPaneHasZenActiveTab"
            class="editor-split-pane editor-split-pane-first"
            :style="firstPaneStyle"
        >
            <EditorPanesGrid
                :node="splitNode.first"
                :panes="panes"
                :tabs="tabs"
                :active-pane-id="activePaneId"
                :is-startup-open-claim-pending="isStartupOpenClaimPending"
                :is-tab-transition-busy="isTabTransitionBusy"
                :tab-context-availability-by-pane="tabContextAvailabilityByPane"
                :start-section-by-tab-id="startSectionByTabId"
                :tab-lifecycle-by-id="tabLifecycleById"
                :view-state-by-tab-id="viewStateByTabId"
                :document-records-by-tab-id="documentRecordsByTabId"
                :document-sessions-by-tab-id="documentSessionsByTabId"
                :zen-mode="zenMode"
                :zen-active-tab-id="zenActiveTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                @activate-pane="handleActivatePane"
                @activate-tab="handleActivateTab"
                @close-tab="handleCloseTab"
                @new-tab="handleNewTab"
                @reorder-tab="handleReorderTab"
                @move-tab-direction="handleMoveTabDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="handleSetWorkspaceRef"
                @update-document-record="handleUpdateDocumentRecord"
                @update-tab-session-state="handleUpdateTabSessionState"
                @update-tab-start-section="handleUpdateTabStartSection"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
                @update-split-ratio="handleUpdateSplitRatio"
                @update-layout-resizing="handleUpdateLayoutResizing"
            />
        </div>

        <div
            v-if="!zenMode"
            class="editor-sash"
            :class="splitNode!.orientation === 'horizontal' ? 'is-vertical-line' : 'is-horizontal-line'"
            role="separator"
            :aria-orientation="splitNode!.orientation === 'horizontal' ? 'vertical' : 'horizontal'"
            @pointerdown.prevent="handleSplitResizePointerDown"
        />

        <div
            v-if="!zenMode || secondPaneHasZenActiveTab"
            class="editor-split-pane editor-split-pane-second"
        >
            <EditorPanesGrid
                :node="splitNode.second"
                :panes="panes"
                :tabs="tabs"
                :active-pane-id="activePaneId"
                :is-startup-open-claim-pending="isStartupOpenClaimPending"
                :is-tab-transition-busy="isTabTransitionBusy"
                :tab-context-availability-by-pane="tabContextAvailabilityByPane"
                :start-section-by-tab-id="startSectionByTabId"
                :tab-lifecycle-by-id="tabLifecycleById"
                :view-state-by-tab-id="viewStateByTabId"
                :document-records-by-tab-id="documentRecordsByTabId"
                :document-sessions-by-tab-id="documentSessionsByTabId"
                :zen-mode="zenMode"
                :zen-active-tab-id="zenActiveTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                @activate-pane="handleActivatePane"
                @activate-tab="handleActivateTab"
                @close-tab="handleCloseTab"
                @new-tab="handleNewTab"
                @reorder-tab="handleReorderTab"
                @move-tab-direction="handleMoveTabDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="handleSetWorkspaceRef"
                @update-document-record="handleUpdateDocumentRecord"
                @update-tab-session-state="handleUpdateTabSessionState"
                @update-tab-start-section="handleUpdateTabStartSection"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
                @update-split-ratio="handleUpdateSplitRatio"
                @update-layout-resizing="handleUpdateLayoutResizing"
            />
        </div>
    </div>
</template>

<script setup lang="ts">

import {
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { keyBy } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import type { ITab } from '@app/types/tabs';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type {
    IEditorPaneState,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TPaneOrientation,
} from '@contracts/editorPanes';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import DeferredDocumentWorkspaceHost from '@app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue';
import TabBar from '@app/modules/workspace-shell/components/layout/TabBar.vue';
import type { TStartSection } from '@app/types/startSection';
import type {
    ITabLifecycleState,
    ITabViewSessionState,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import {resolveEditorPaneSplitBounds} from '@app/modules/workspace-shell/layout/resolveEditorPaneSplitBounds';

defineOptions({name: 'EditorPanesGrid'});

const {
    documentRecordsByTabId,
    documentSessionsByTabId,
    panes,
    node,
    tabLifecycleById,
    tabs,
    viewStateByTabId,
    isWorkspaceLayoutResizing = false,
    zenActiveTabId,
    zenMode,
} = defineProps<{
    node: TEditorLayoutNode;
    panes: IEditorPaneState[];
    tabs: ITab[];
    activePaneId: string | null;
    isStartupOpenClaimPending: boolean;
    isTabTransitionBusy: boolean;
    tabContextAvailabilityByPane: Record<string, ITabContextAvailability>;
    startSectionByTabId: Record<string, TStartSection>;
    tabLifecycleById: Record<string, ITabLifecycleState>;
    viewStateByTabId: Record<string, ITabViewSessionState>;
    documentRecordsByTabId: Record<string, IWorkspaceDocumentRecord>;
    documentSessionsByTabId: Record<string, IWorkspaceDocumentSessionController>;
    zenMode: boolean;
    zenActiveTabId: string | null;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
}>();

const emit = defineEmits<{
    'activate-pane': [paneId: string];
    'activate-tab': [paneId: string, tabId: string];
    'close-tab': [paneId: string, tabId: string];
    'new-tab': [paneId: string];
    'reorder-tab': [paneId: string, fromIndex: number, toIndex: number];
    'move-tab-direction': [
        paneId: string,
        tabId: string,
        direction: 'left' | 'right',
        targetIndex?: number | null,
    ];
    'tab-context-command': [paneId: string, tabId: string, command: TTabContextCommand];
    'set-workspace-ref': [tabId: string, el: unknown];
    'update-document-record': [tabId: string, record: IWorkspaceDocumentRecord];
    'update-tab-session-state': [tabId: string, state: ITabViewSessionState];
    'update-tab-start-section': [tabId: string, section: TStartSection];
    'open-in-new-tab': [result: string | TOpenFileResult, paneId: string];
    'request-close-tab': [paneId: string, tabId: string];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'update-split-ratio': [splitId: string, ratio: number];
    'update-layout-resizing': [value: boolean];
}>();

const splitContainerRef = ref<HTMLElement | null>(null);
const splitAxisSize = ref(0);
const hasMultiplePanes = computed(() => panes.length > 1);
const leafNode = computed(() => (node.type === 'leaf' ? node : null));
const splitNode = computed<IEditorLayoutSplitNode | null>(() => (node.type === 'split' ? node : null));
const splitRatioBounds = computed(() => resolveEditorPaneSplitBounds(splitAxisSize.value));
useResizeObserver(splitContainerRef, ([entry]) => {
    const split = splitNode.value;
    if (!entry || !split) {
        splitAxisSize.value = 0;
        return;
    }
    splitAxisSize.value = split.orientation === 'horizontal'
        ? entry.contentRect.width
        : entry.contentRect.height;
});
const paneById = computed(() => {
    return new Map(Object.entries(keyBy(panes, pane => pane.paneId)));
});
const tabById = computed(() => {
    return new Map(Object.entries(keyBy(tabs, tab => tab.id)));
});
function resolveRecordTab(tab: ITab): ITab {
    const recordTab = documentRecordsByTabId[tab.id]?.tab;
    return recordTab
        ? {
            ...tab,
            ...recordTab,
        }
        : tab;
}

const tabsByPaneId = computed(() => {
    const map = new Map<string, ITab[]>();
    const tabLookup = tabById.value;

    for (const pane of panes) {
        const paneTabs: ITab[] = [];
        for (const tabId of pane.tabIds) {
            const tab = tabLookup.get(tabId);
            if (tab) {
                paneTabs.push(resolveRecordTab(tab));
            }
        }
        map.set(pane.paneId, paneTabs);
    }

    return map;
});
const firstPaneStyle = computed(() => {
    if (!splitNode.value) {
        return undefined;
    }

    if (zenMode) {
        return {flexBasis: '100%'};
    }

    const ratio = clamp(
        splitNode.value.ratio,
        splitRatioBounds.value.minRatio,
        splitRatioBounds.value.maxRatio,
    );
    return {flexBasis: `${ratio * 100}%`};
});
const firstPaneHasZenActiveTab = computed(() => (
    Boolean(splitNode.value && nodeContainsTab(splitNode.value.first, zenActiveTabId))
));
const secondPaneHasZenActiveTab = computed(() => (
    Boolean(splitNode.value && nodeContainsTab(splitNode.value.second, zenActiveTabId))
));

const paneForLeaf = computed(() => {
    const leaf = leafNode.value;
    if (!leaf) {
        return null;
    }

    return paneById.value.get(leaf.paneId) ?? null;
});

function tabsForPane(paneId: string) {
    const paneTabs = tabsByPaneId.value.get(paneId) ?? [];
    if (!zenMode || !zenActiveTabId) {
        return paneTabs;
    }

    return paneTabs.filter(tab => tab.id === zenActiveTabId);
}

function shouldMountHost(tabId: string) {
    return tabLifecycleById[tabId]?.shouldMountHost !== false;
}

function nodeContainsTab(node: TEditorLayoutNode, tabId: string | null): boolean {
    if (!tabId) {
        return false;
    }

    if (node.type === 'leaf') {
        return tabsByPaneId.value.get(node.paneId)?.some(tab => tab.id === tabId) ?? false;
    }

    return nodeContainsTab(node.first, tabId) || nodeContainsTab(node.second, tabId);
}

function currentLeafPaneId() {
    return paneForLeaf.value?.paneId ?? null;
}

function handleLeafTabActivate(tabId: string) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('activate-tab', paneId, tabId);
    }
}

function handleLeafTabClose(tabId: string) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('close-tab', paneId, tabId);
    }
}

function handleLeafNewTab() {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('new-tab', paneId);
    }
}

function handleLeafTabReorder(fromIndex: number, toIndex: number) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('reorder-tab', paneId, fromIndex, toIndex);
    }
}

function handleLeafTabMoveDirection(
    tabId: string,
    direction: 'left' | 'right',
    targetIndex?: number | null,
) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('move-tab-direction', paneId, tabId, direction, targetIndex);
    }
}

function handleLeafTabContextCommand(tabId: string, command: TTabContextCommand) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('tab-context-command', paneId, tabId, command);
    }
}

function handleWorkspaceDocumentRecordUpdate(tabId: string, record: IWorkspaceDocumentRecord) {
    emit('update-document-record', tabId, record);
}

function handleWorkspaceSessionStateUpdate(tabId: string, state: ITabViewSessionState) {
    emit('update-tab-session-state', tabId, state);
}

function handleWorkspaceStartSectionUpdate(tabId: string, section: TStartSection) {
    emit('update-tab-start-section', tabId, section);
}

function handleLeafOpenInNewTab(result: string | TOpenFileResult) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('open-in-new-tab', result, paneId);
    }
}

function handleLeafRequestCloseTab(tabId: string) {
    const paneId = currentLeafPaneId();
    if (paneId) {
        emit('request-close-tab', paneId, tabId);
    }
}

function handleActivatePane(paneId: string) {
    emit('activate-pane', paneId);
}

function handleActivateTab(paneId: string, tabId: string) {
    emit('activate-tab', paneId, tabId);
}

function handleCloseTab(paneId: string, tabId: string) {
    emit('close-tab', paneId, tabId);
}

function handleNewTab(paneId: string) {
    emit('new-tab', paneId);
}

function handleReorderTab(paneId: string, fromIndex: number, toIndex: number) {
    emit('reorder-tab', paneId, fromIndex, toIndex);
}

function handleMoveTabDirection(
    paneId: string,
    tabId: string,
    direction: 'left' | 'right',
    targetIndex?: number | null,
) {
    emit('move-tab-direction', paneId, tabId, direction, targetIndex);
}

function handleTabContextCommand(paneId: string, tabId: string, command: TTabContextCommand) {
    emit('tab-context-command', paneId, tabId, command);
}

function handleSetWorkspaceRef(tabId: string, el: unknown) {
    emit('set-workspace-ref', tabId, el);
}

function handleWorkspaceExposeReady(tabId: string, expose: IWorkspaceExpose) {
    emit('set-workspace-ref', tabId, expose);
}

function handleWorkspaceExposeReleased(tabId: string) {
    emit('set-workspace-ref', tabId, null);
}

function handleUpdateDocumentRecord(tabId: string, record: IWorkspaceDocumentRecord) {
    emit('update-document-record', tabId, record);
}

function handleUpdateTabSessionState(tabId: string, state: ITabViewSessionState) {
    emit('update-tab-session-state', tabId, state);
}

function handleUpdateTabStartSection(tabId: string, section: TStartSection) {
    emit('update-tab-start-section', tabId, section);
}

function handleOpenInNewTab(result: string | TOpenFileResult, paneId: string) {
    emit('open-in-new-tab', result, paneId);
}

function handleRequestCloseTab(paneId: string, tabId: string) {
    emit('request-close-tab', paneId, tabId);
}

function handleOpenSettings() {
    emit('open-settings');
}

function handleOpenCombine() {
    emit('open-combine');
}

function handleToggleFullscreen() {
    emit('toggle-fullscreen');
}

function handleUpdateSplitRatio(splitId: string, ratio: number) {
    emit('update-split-ratio', splitId, ratio);
}

function handleUpdateLayoutResizing(value: boolean) {
    emit('update-layout-resizing', value);
}

function handlePanePointerDown(paneId: string) {
    emit('activate-pane', paneId);
}

let moveListener: ((event: PointerEvent) => void) | null = null;
let upListener: ((event: PointerEvent) => void) | null = null;
let isSplitResizing = false;
const resizeWindowTarget = shallowRef<Window | undefined>();
const coalescedResizeMove = createRafCoalescedCallback((event: PointerEvent) => {
    moveListener?.(event);
});

function clearResizeListeners() {
    coalescedResizeMove.cancel();
    resizeWindowTarget.value = undefined;
    moveListener = null;
    upListener = null;
    if (isSplitResizing) {
        isSplitResizing = false;
        emit('update-layout-resizing', false);
    }
}

function startResize(event: PointerEvent, splitId: string, orientation: TPaneOrientation) {
    const container = splitContainerRef.value;
    if (!container) {
        return;
    }

    const startRect = container.getBoundingClientRect();
    const axisSize = orientation === 'horizontal' ? startRect.width : startRect.height;
    const ratioBounds = resolveEditorPaneSplitBounds(axisSize);
    isSplitResizing = true;
    emit('update-layout-resizing', true);

    moveListener = (nextEvent: PointerEvent) => {
        if (orientation === 'horizontal') {
            const raw = (nextEvent.clientX - startRect.left) / startRect.width;
            emit('update-split-ratio', splitId, clamp(raw, ratioBounds.minRatio, ratioBounds.maxRatio));
            return;
        }

        const raw = (nextEvent.clientY - startRect.top) / startRect.height;
        emit('update-split-ratio', splitId, clamp(raw, ratioBounds.minRatio, ratioBounds.maxRatio));
    };

    upListener = () => {
        clearResizeListeners();
    };

    resizeWindowTarget.value = window;

    const sash = event.currentTarget;
    if (sash instanceof Element && 'setPointerCapture' in sash) {
        const pointerSash = sash as Element & { setPointerCapture?: (pointerId: number) => void };
        pointerSash.setPointerCapture?.(event.pointerId);
    }
}

function handleSplitResizePointerDown(event: PointerEvent) {
    const split = splitNode.value;
    if (!split) {
        return;
    }
    startResize(event, split.id, split.orientation);
}

useEventListener(resizeWindowTarget, 'pointermove', (event: PointerEvent) => {
    coalescedResizeMove.schedule(event);
});
useEventListener(resizeWindowTarget, 'pointerup', (event: PointerEvent) => {
    coalescedResizeMove.flush(event);
    upListener?.(event);
});
useEventListener(resizeWindowTarget, 'pointercancel', (event: PointerEvent) => {
    coalescedResizeMove.flush(event);
    upListener?.(event);
});

onUnmounted(() => {
    clearResizeListeners();
});
</script>

<style scoped>
.editor-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
    border: 0;
    background: var(--app-window-bg);
}

.editor-pane.has-multiple-panes {
    position: relative;
}

.editor-pane.has-multiple-panes :deep(.tab-bar) {
    transition: background-color 0.12s ease, border-bottom-color 0.12s ease, box-shadow 0.12s ease;
}

.editor-pane.has-multiple-panes.is-active :deep(.tab-bar) {
    background: var(--app-editor-pane-active-tabbar-bg);
    border-bottom-color: var(--app-editor-pane-active-tabbar-divider);
    box-shadow: inset 0 1px 0 var(--app-editor-pane-active-tabbar-glow);

    --app-tab-divider: var(--app-editor-pane-active-tabbar-divider);
    --app-tab-hover-bg: color-mix(in oklab, var(--app-editor-pane-active-tabbar-bg) 55%, var(--ui-bg) 45%);
}

.editor-pane-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    box-sizing: border-box;
}

.editor-pane-content > * {
    flex: 1;
    width: 100%;
    min-width: 0;
    min-height: 0;
}

.editor-split {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--app-editor-pane-grid-bg);
    box-sizing: border-box;
}

.editor-split.is-horizontal {
    flex-direction: row;
}

.editor-split.is-vertical {
    flex-direction: column;
}

.editor-split-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex: 1;
    box-sizing: border-box;
}

.editor-split-pane > * {
    flex: 1;
    min-width: 0;
    min-height: 0;
}

.editor-split-pane-first {
    flex-grow: 0;
    flex-shrink: 0;
}

.editor-sash {
    flex-shrink: 0;
    background: var(--app-editor-sash-bg);
    transition: background-color 0.12s ease;
}

.editor-sash:hover {
    background: var(--app-editor-sash-bg-hover);
}

.editor-sash.is-vertical-line {
    width: var(--app-editor-sash-size);
    cursor: col-resize;
}

.editor-sash.is-horizontal-line {
    height: var(--app-editor-sash-size);
    cursor: row-resize;
}
</style>
