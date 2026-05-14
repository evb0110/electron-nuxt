<template>
    <div
        v-if="leafNode"
        class="editor-group-pane"
        :class="{
            'is-active': leafNode.groupId === activeGroupId,
            'has-multiple-groups': hasMultipleGroups,
        }"
        @pointerdown="handleGroupPointerDown(leafNode.groupId)"
    >
        <template v-if="groupForLeaf">
            <TabBar
                v-if="!zenMode"
                :tabs="tabsForGroup(groupForLeaf!.id)"
                :active-tab-id="groupForLeaf!.activeTabId"
                :context-availability="tabContextAvailabilityByGroup[groupForLeaf!.id] ?? null"
                @activate="handleLeafTabActivate"
                @close="handleLeafTabClose"
                @new-tab="handleLeafNewTab"
                @reorder="handleLeafTabReorder"
                @move-direction="handleLeafTabMoveDirection"
                @tab-context-command="handleLeafTabContextCommand"
            />
            <div class="editor-group-content">
                <DeferredDocumentWorkspaceHost
                    v-for="tab in tabsForGroup(groupForLeaf!.id)"
                    v-show="tab.id === groupForLeaf!.activeTabId"
                    :key="tab.id"
                    :ref="workspaceRefHandler(tab.id)"
                    :tab-id="tab.id"
                    :has-document-hint="hasDocumentMountHint(tab)"
                    :is-startup-open-claim-pending="isStartupOpenClaimPending"
                    :is-active="groupForLeaf!.id === activeGroupId && tab.id === groupForLeaf!.activeTabId"
                    :is-tab-transition-busy="isTabTransitionBusy"
                    :is-fullscreen="isFullscreen"
                    :fullscreen-supported="fullscreenSupported"
                    :start-section="startSectionByTabId[tab.id] ?? 'recent'"
                    @update-tab="handleWorkspaceTabUpdate(tab.id, $event)"
                    @update:start-section="handleWorkspaceStartSectionUpdate(tab.id, $event)"
                    @open-in-new-tab="handleLeafOpenInNewTab"
                    @request-close-tab="handleLeafRequestCloseTab(tab.id)"
                    @open-settings="handleOpenSettings"
                    @open-combine="handleOpenCombine"
                    @toggle-fullscreen="handleToggleFullscreen"
                />
            </div>
        </template>
        <div v-else class="editor-group-content" />
    </div>

    <div
        v-else-if="splitNode"
        ref="splitContainerRef"
        class="editor-split"
        :class="splitNode.orientation === 'horizontal' ? 'is-horizontal' : 'is-vertical'"
    >
        <div
            v-if="!zenMode || firstPaneHasZenActiveTab"
            class="editor-split-pane editor-split-pane-first"
            :style="firstPaneStyle"
        >
            <EditorGroupsGrid
                :node="splitNode.first"
                :groups="groups"
                :tabs="tabs"
                :active-group-id="activeGroupId"
                :is-startup-open-claim-pending="isStartupOpenClaimPending"
                :is-tab-transition-busy="isTabTransitionBusy"
                :tab-context-availability-by-group="tabContextAvailabilityByGroup"
                :start-section-by-tab-id="startSectionByTabId"
                :zen-mode="zenMode"
                :zen-active-tab-id="zenActiveTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @activate-group="handleActivateGroup"
                @activate-tab="handleActivateTab"
                @close-tab="handleCloseTab"
                @new-tab="handleNewTab"
                @reorder-tab="handleReorderTab"
                @move-tab-direction="handleMoveTabDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="handleSetWorkspaceRef"
                @update-tab="handleUpdateTab"
                @update-tab-start-section="handleUpdateTabStartSection"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
                @update-split-ratio="handleUpdateSplitRatio"
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
            <EditorGroupsGrid
                :node="splitNode.second"
                :groups="groups"
                :tabs="tabs"
                :active-group-id="activeGroupId"
                :is-startup-open-claim-pending="isStartupOpenClaimPending"
                :is-tab-transition-busy="isTabTransitionBusy"
                :tab-context-availability-by-group="tabContextAvailabilityByGroup"
                :start-section-by-tab-id="startSectionByTabId"
                :zen-mode="zenMode"
                :zen-active-tab-id="zenActiveTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @activate-group="handleActivateGroup"
                @activate-tab="handleActivateTab"
                @close-tab="handleCloseTab"
                @new-tab="handleNewTab"
                @reorder-tab="handleReorderTab"
                @move-tab-direction="handleMoveTabDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="handleSetWorkspaceRef"
                @update-tab="handleUpdateTab"
                @update-tab-start-section="handleUpdateTabStartSection"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
                @update-split-ratio="handleUpdateSplitRatio"
            />
        </div>
    </div>
</template>

<script setup lang="ts">

import { useEventListener } from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type {
    IEditorGroupState,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TGroupOrientation,
} from '@app/types/editorGroups';
import type { TOpenFileResult } from '@contracts/platformApi';
import { hasDocumentMountHint } from '@app/modules/workspace-shell/composables/workspaceHostMounting';
import DeferredDocumentWorkspaceHost from '@app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue';
import TabBar from '@app/modules/workspace-shell/components/layout/TabBar.vue';
import type { TStartSection } from '@app/types/startPage';

defineOptions({name: 'EditorGroupsGrid'});

const {
    groups,
    node,
    tabs,
    zenActiveTabId,
    zenMode,
} = defineProps<{
    node: TEditorLayoutNode;
    groups: IEditorGroupState[];
    tabs: ITab[];
    activeGroupId: string | null;
    isStartupOpenClaimPending: boolean;
    isTabTransitionBusy: boolean;
    tabContextAvailabilityByGroup: Record<string, ITabContextAvailability>;
    startSectionByTabId: Record<string, TStartSection>;
    zenMode: boolean;
    zenActiveTabId: string | null;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
}>();

const emit = defineEmits<{
    'activate-group': [groupId: string];
    'activate-tab': [groupId: string, tabId: string];
    'close-tab': [groupId: string, tabId: string];
    'new-tab': [groupId: string];
    'reorder-tab': [groupId: string, fromIndex: number, toIndex: number];
    'move-tab-direction': [groupId: string, tabId: string, direction: 'left' | 'right'];
    'tab-context-command': [groupId: string, tabId: string, command: TTabContextCommand];
    'set-workspace-ref': [tabId: string, el: unknown];
    'update-tab': [tabId: string, updates: TTabUpdate];
    'update-tab-start-section': [tabId: string, section: TStartSection];
    'open-in-new-tab': [result: string | TOpenFileResult, groupId: string];
    'request-close-tab': [groupId: string, tabId: string];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'update-split-ratio': [splitId: string, ratio: number];
}>();

const splitContainerRef = ref<HTMLElement | null>(null);
const workspaceRefHandlersByTabId = new Map<string, (el: unknown) => void>();
const hasMultipleGroups = computed(() => groups.length > 1);
const leafNode = computed(() => (node.type === 'leaf' ? node : null));
const splitNode = computed<IEditorLayoutSplitNode | null>(() => (node.type === 'split' ? node : null));
const groupById = computed(() => {
    const map = new Map<string, IEditorGroupState>();
    for (const group of groups) {
        map.set(group.id, group);
    }
    return map;
});
const tabById = computed(() => {
    const map = new Map<string, ITab>();
    for (const tab of tabs) {
        map.set(tab.id, tab);
    }
    return map;
});
const tabsByGroupId = computed(() => {
    const map = new Map<string, ITab[]>();
    const tabLookup = tabById.value;

    for (const group of groups) {
        const groupTabs: ITab[] = [];
        for (const tabId of group.tabIds) {
            const tab = tabLookup.get(tabId);
            if (tab) {
                groupTabs.push(tab);
            }
        }
        map.set(group.id, groupTabs);
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

    return {flexBasis: `${clamp(splitNode.value.ratio, 0.15, 0.85) * 100}%`};
});
const firstPaneHasZenActiveTab = computed(() => (
    Boolean(splitNode.value && nodeContainsTab(splitNode.value.first, zenActiveTabId))
));
const secondPaneHasZenActiveTab = computed(() => (
    Boolean(splitNode.value && nodeContainsTab(splitNode.value.second, zenActiveTabId))
));

const groupForLeaf = computed(() => {
    const leaf = leafNode.value;
    if (!leaf) {
        return null;
    }

    return groupById.value.get(leaf.groupId) ?? null;
});

function tabsForGroup(groupId: string) {
    const groupTabs = tabsByGroupId.value.get(groupId) ?? [];
    if (!zenMode || !zenActiveTabId) {
        return groupTabs;
    }

    return groupTabs.filter(tab => tab.id === zenActiveTabId);
}

function nodeContainsTab(node: TEditorLayoutNode, tabId: string | null): boolean {
    if (!tabId) {
        return false;
    }

    if (node.type === 'leaf') {
        return tabsByGroupId.value.get(node.groupId)?.some(tab => tab.id === tabId) ?? false;
    }

    return nodeContainsTab(node.first, tabId) || nodeContainsTab(node.second, tabId);
}

function workspaceRefHandler(tabId: string) {
    const existing = workspaceRefHandlersByTabId.get(tabId);
    if (existing) {
        return existing;
    }

    const handler = (el: unknown) => {
        emit('set-workspace-ref', tabId, el);
    };
    workspaceRefHandlersByTabId.set(tabId, handler);
    return handler;
}

function currentLeafGroupId() {
    return groupForLeaf.value?.id ?? null;
}

function handleLeafTabActivate(tabId: string) {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('activate-tab', groupId, tabId);
    }
}

function handleLeafTabClose(tabId: string) {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('close-tab', groupId, tabId);
    }
}

function handleLeafNewTab() {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('new-tab', groupId);
    }
}

function handleLeafTabReorder(fromIndex: number, toIndex: number) {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('reorder-tab', groupId, fromIndex, toIndex);
    }
}

function handleLeafTabMoveDirection(tabId: string, direction: 'left' | 'right') {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('move-tab-direction', groupId, tabId, direction);
    }
}

function handleLeafTabContextCommand(tabId: string, command: TTabContextCommand) {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('tab-context-command', groupId, tabId, command);
    }
}

function handleWorkspaceTabUpdate(tabId: string, updates: TTabUpdate) {
    emit('update-tab', tabId, updates);
}

function handleWorkspaceStartSectionUpdate(tabId: string, section: TStartSection) {
    emit('update-tab-start-section', tabId, section);
}

function handleLeafOpenInNewTab(result: string | TOpenFileResult) {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('open-in-new-tab', result, groupId);
    }
}

function handleLeafRequestCloseTab(tabId: string) {
    const groupId = currentLeafGroupId();
    if (groupId) {
        emit('request-close-tab', groupId, tabId);
    }
}

function handleActivateGroup(groupId: string) {
    emit('activate-group', groupId);
}

function handleActivateTab(groupId: string, tabId: string) {
    emit('activate-tab', groupId, tabId);
}

function handleCloseTab(groupId: string, tabId: string) {
    emit('close-tab', groupId, tabId);
}

function handleNewTab(groupId: string) {
    emit('new-tab', groupId);
}

function handleReorderTab(groupId: string, fromIndex: number, toIndex: number) {
    emit('reorder-tab', groupId, fromIndex, toIndex);
}

function handleMoveTabDirection(groupId: string, tabId: string, direction: 'left' | 'right') {
    emit('move-tab-direction', groupId, tabId, direction);
}

function handleTabContextCommand(groupId: string, tabId: string, command: TTabContextCommand) {
    emit('tab-context-command', groupId, tabId, command);
}

function handleSetWorkspaceRef(tabId: string, el: unknown) {
    emit('set-workspace-ref', tabId, el);
}

function handleUpdateTab(tabId: string, updates: TTabUpdate) {
    emit('update-tab', tabId, updates);
}

function handleUpdateTabStartSection(tabId: string, section: TStartSection) {
    emit('update-tab-start-section', tabId, section);
}

function handleOpenInNewTab(result: string | TOpenFileResult, groupId: string) {
    emit('open-in-new-tab', result, groupId);
}

function handleRequestCloseTab(groupId: string, tabId: string) {
    emit('request-close-tab', groupId, tabId);
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

function handleGroupPointerDown(groupId: string) {
    emit('activate-group', groupId);
}

let moveListener: ((event: PointerEvent) => void) | null = null;
let upListener: ((event: PointerEvent) => void) | null = null;
let stopMoveListener: (() => void) | null = null;
let stopUpListener: (() => void) | null = null;
let stopCancelListener: (() => void) | null = null;

function clearResizeListeners() {
    stopMoveListener?.();
    stopMoveListener = null;
    stopUpListener?.();
    stopUpListener = null;
    stopCancelListener?.();
    stopCancelListener = null;
    moveListener = null;
    upListener = null;
}

function startResize(event: PointerEvent, splitId: string, orientation: TGroupOrientation) {
    const container = splitContainerRef.value;
    if (!container) {
        return;
    }

    const startRect = container.getBoundingClientRect();

    moveListener = (nextEvent: PointerEvent) => {
        if (orientation === 'horizontal') {
            const raw = (nextEvent.clientX - startRect.left) / startRect.width;
            emit('update-split-ratio', splitId, raw);
            return;
        }

        const raw = (nextEvent.clientY - startRect.top) / startRect.height;
        emit('update-split-ratio', splitId, raw);
    };

    upListener = () => {
        clearResizeListeners();
    };

    stopMoveListener = useEventListener(window, 'pointermove', moveListener);
    stopUpListener = useEventListener(window, 'pointerup', upListener);
    stopCancelListener = useEventListener(window, 'pointercancel', upListener);

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

onUnmounted(() => {
    clearResizeListeners();
    workspaceRefHandlersByTabId.clear();
});

watch(() => tabs, (tabs) => {
    const activeTabIds = new Set(tabs.map(tab => tab.id));
    for (const tabId of workspaceRefHandlersByTabId.keys()) {
        if (!activeTabIds.has(tabId)) {
            workspaceRefHandlersByTabId.delete(tabId);
        }
    }
}, {deep: false});
</script>

<style scoped>
.editor-group-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
    border: 0;
    background: var(--app-window-bg);
}

.editor-group-pane.has-multiple-groups {
    position: relative;
}

.editor-group-pane.has-multiple-groups :deep(.tab-bar) {
    transition: background-color 0.12s ease, border-bottom-color 0.12s ease, box-shadow 0.12s ease;
}

.editor-group-pane.has-multiple-groups.is-active :deep(.tab-bar) {
    background: var(--app-editor-group-active-tabbar-bg);
    border-bottom-color: var(--app-editor-group-active-tabbar-divider);
    box-shadow: inset 0 1px 0 var(--app-editor-group-active-tabbar-glow);

    --app-tab-divider: var(--app-editor-group-active-tabbar-divider);
    --app-tab-hover-bg: color-mix(in oklab, var(--app-editor-group-active-tabbar-bg) 55%, var(--ui-bg) 45%);
}

.editor-group-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    box-sizing: border-box;
}

.editor-group-content > * {
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
    background: var(--app-editor-group-grid-bg);
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
