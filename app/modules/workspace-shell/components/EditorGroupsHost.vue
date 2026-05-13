<template>
    <div class="flex-1 min-h-0 min-w-0">
        <EditorGroupsGrid
            v-if="layout"
            :node="layout"
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
</template>

<script setup lang="ts">
import type { TOpenFileResult } from '@contracts/platform-api';
import EditorGroupsGrid from '@app/modules/workspace-shell/components/EditorGroupsGrid.vue';
import type {
    IEditorGroupState,
    TEditorLayoutNode,
} from '@app/types/editor-groups';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tab-context-menu';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type { TStartSection } from '@app/types/start-page';

defineOptions({ name: 'EditorGroupsHost' });

defineProps<{
    layout: TEditorLayoutNode | null;
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
    'open-in-new-tab': [result: string | TOpenFileResult, groupId?: string];
    'request-close-tab': [groupId: string, tabId: string];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'update-split-ratio': [splitId: string, ratio: number];
}>();

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

function handleOpenInNewTab(result: string | TOpenFileResult, groupId?: string) {
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
</script>
