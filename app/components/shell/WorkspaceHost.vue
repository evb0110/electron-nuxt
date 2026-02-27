<template>
    <div class="flex-1 min-h-0 min-w-0">
        <EditorGroupsGrid
            v-if="layout && chromeHostsReady"
            :node="layout"
            :groups="groups"
            :tabs="tabs"
            :active-group-id="activeGroupId"
            :is-tab-transition-busy="isTabTransitionBusy"
            :tab-context-availability-by-group="tabContextAvailabilityByGroup"
            @activate-group="emit('activate-group', $event)"
            @activate-tab="(groupId, tabId) => emit('activate-tab', groupId, tabId)"
            @close-tab="(groupId, tabId) => emit('close-tab', groupId, tabId)"
            @new-tab="emit('new-tab', $event)"
            @reorder-tab="(groupId, fromIndex, toIndex) => emit('reorder-tab', groupId, fromIndex, toIndex)"
            @move-tab-direction="(groupId, tabId, direction) => emit('move-tab-direction', groupId, tabId, direction)"
            @tab-context-command="(groupId, tabId, command) => emit('tab-context-command', groupId, tabId, command)"
            @set-workspace-ref="(tabId, el) => emit('set-workspace-ref', tabId, el)"
            @update-tab="(tabId, updates) => emit('update-tab', tabId, updates)"
            @open-in-new-tab="(result, groupId) => emit('open-in-new-tab', result, groupId)"
            @request-close-tab="(groupId, tabId) => emit('request-close-tab', groupId, tabId)"
            @open-settings="emit('open-settings')"
            @update-split-ratio="(splitId, ratio) => emit('update-split-ratio', splitId, ratio)"
        />
    </div>
</template>

<script setup lang="ts">
import type { TOpenFileResult } from '@contracts/electron-api';
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

defineOptions({ name: 'WorkspaceHost' });

defineProps<{
    layout: TEditorLayoutNode | null;
    chromeHostsReady: boolean;
    groups: IEditorGroupState[];
    tabs: ITab[];
    activeGroupId: string | null;
    isTabTransitionBusy: boolean;
    tabContextAvailabilityByGroup: Record<string, ITabContextAvailability>;
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
    'open-in-new-tab': [result: string | TOpenFileResult, groupId?: string];
    'request-close-tab': [groupId: string, tabId: string];
    'open-settings': [];
    'update-split-ratio': [splitId: string, ratio: number];
}>();
</script>
