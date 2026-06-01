<template>
    <div class="flex-1 min-h-0 min-w-0">
        <EditorPanesGrid
            v-if="layout"
            :node="layout"
            :panes="panes"
            :tabs="tabs"
            :active-pane-id="activePaneId"
            :is-startup-open-claim-pending="isStartupOpenClaimPending"
            :is-tab-transition-busy="isTabTransitionBusy"
            :tab-context-availability-by-pane="tabContextAvailabilityByPane"
            :start-section-by-tab-id="startSectionByTabId"
            :tab-lifecycle-by-id="tabLifecycleById"
            :view-state-by-tab-id="viewStateByTabId"
            :zen-mode="zenMode"
            :zen-active-tab-id="zenActiveTabId"
            :is-fullscreen="isFullscreen"
            :fullscreen-supported="fullscreenSupported"
            @activate-pane="handleActivatePane"
            @activate-tab="handleActivateTab"
            @close-tab="handleCloseTab"
            @new-tab="handleNewTab"
            @reorder-tab="handleReorderTab"
            @move-tab-direction="handleMoveTabDirection"
            @tab-context-command="handleTabContextCommand"
            @set-workspace-ref="handleSetWorkspaceRef"
            @update-tab="handleUpdateTab"
            @update-tab-session-state="handleUpdateTabSessionState"
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
import type { TOpenFileResult } from '@contracts/platformApi';
import EditorPanesGrid from '@app/modules/workspace-shell/components/EditorPanesGrid.vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@app/types/editorPanes';
import type {
    ITabContextAvailability,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type { TStartSection } from '@app/types/startPage';
import type {
    ITabLifecycleState,
    ITabViewSessionState,
} from '@app/modules/workspace-shell/composables/useTabSessionStore';

defineOptions({ name: 'EditorPanesHost' });

defineProps<{
    layout: TEditorLayoutNode | null;
    panes: IEditorPaneState[];
    tabs: ITab[];
    activePaneId: string | null;
    isStartupOpenClaimPending: boolean;
    isTabTransitionBusy: boolean;
    tabContextAvailabilityByPane: Record<string, ITabContextAvailability>;
    startSectionByTabId: Record<string, TStartSection>;
    tabLifecycleById: Record<string, ITabLifecycleState>;
    viewStateByTabId: Record<string, ITabViewSessionState>;
    zenMode: boolean;
    zenActiveTabId: string | null;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
}>();

const emit = defineEmits<{
    'activate-pane': [paneId: string];
    'activate-tab': [paneId: string, tabId: string];
    'close-tab': [paneId: string, tabId: string];
    'new-tab': [paneId: string];
    'reorder-tab': [paneId: string, fromIndex: number, toIndex: number];
    'move-tab-direction': [paneId: string, tabId: string, direction: 'left' | 'right'];
    'tab-context-command': [paneId: string, tabId: string, command: TTabContextCommand];
    'set-workspace-ref': [tabId: string, el: unknown];
    'update-tab': [tabId: string, updates: TTabUpdate];
    'update-tab-session-state': [tabId: string, state: ITabViewSessionState];
    'update-tab-start-section': [tabId: string, section: TStartSection];
    'open-in-new-tab': [result: string | TOpenFileResult, paneId?: string];
    'request-close-tab': [paneId: string, tabId: string];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'update-split-ratio': [splitId: string, ratio: number];
}>();

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

function handleMoveTabDirection(paneId: string, tabId: string, direction: 'left' | 'right') {
    emit('move-tab-direction', paneId, tabId, direction);
}

function handleTabContextCommand(paneId: string, tabId: string, command: TTabContextCommand) {
    emit('tab-context-command', paneId, tabId, command);
}

function handleSetWorkspaceRef(tabId: string, el: unknown) {
    emit('set-workspace-ref', tabId, el);
}

function handleUpdateTab(tabId: string, updates: TTabUpdate) {
    emit('update-tab', tabId, updates);
}

function handleUpdateTabSessionState(tabId: string, state: ITabViewSessionState) {
    emit('update-tab-session-state', tabId, state);
}

function handleUpdateTabStartSection(tabId: string, section: TStartSection) {
    emit('update-tab-start-section', tabId, section);
}

function handleOpenInNewTab(result: string | TOpenFileResult, paneId?: string) {
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
</script>
