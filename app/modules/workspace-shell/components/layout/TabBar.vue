<template>
    <div ref="tabBarRef" class="tab-bar">
        <div class="tab-list" role="tablist">
            <div
                v-for="(tab, index) in tabs"
                :key="tab.id"
                :data-tab-id="tab.id"
                role="tab"
                class="tab"
                :class="{
                    'is-active': tab.id === activeTabId,
                    'is-dirty': tab.isDirty,
                    'is-dragging': isDragging && dragIndex === index,
                }"
                :aria-label="resolveTabTitle(tab)"
                :aria-description="tab.isDirty ? t('tabs.unsavedChanges') : undefined"
                :aria-selected="tab.id === activeTabId"
                :tabindex="tab.id === activeTabId ? 0 : -1"
                @click="handleTabClick(tab.id)"
                @auxclick.prevent="handleAuxClick($event, tab.id)"
                @keydown="handleTabKeydown($event, tab.id)"
                @pointerdown="onPointerDown($event, index)"
                @contextmenu.prevent.stop="openTabContextMenu($event, tab.id)"
            >
                <AppTooltip
                    :text="resolveTabTitle(tab)"
                    :delay-duration="800"
                    usefulness="overflow"
                >
                    <span class="tab-label">{{ tab.fileName ?? t('tabs.newTab') }}</span>
                </AppTooltip>
                <button
                    type="button"
                    class="tab-close"
                    :class="{ 'is-visible': tab.id === activeTabId }"
                    :aria-label="t('tabs.closeTab')"
                    :disabled="!canCloseTabs"
                    @pointerdown.stop
                    @click.stop="requestClose(tab.id)"
                >
                    <Icon name="ph:x" size="14" />
                </button>
            </div>
            <button
                type="button"
                class="tab-new"
                :aria-label="t('tabs.newTab')"
                @click="handleNewTab"
            >
                <Icon name="ph:plus" size="14" />
            </button>
        </div>
    </div>

    <UDropdownMenu
        v-model:open="contextMenuOpen"
        :items="contextMenuItems"
        :content="contextMenuContentOptions"
        :ui="contextMenuUi"
        portal="body"
    >
        <button
            type="button"
            class="tab-context-menu-anchor"
            :style="contextMenuAnchorStyle"
            tabindex="-1"
            aria-hidden="true"
        />
    </UDropdownMenu>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core';
import type { ITab } from '@app/types/tabs';
import { useTabDragReorder } from '@app/modules/workspace-shell/composables/useTabDragReorder';
import type { TPaneDirection } from '@contracts/editorPanes';
import { getDocumentRefDisplayLabel } from '@app/utils/documentRef';
import type {
    ITabContextAvailability,
    TDirectionalTabContextCommand,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import type { IWindowTabTargetWindow } from '@contracts/windowTabs';
import {
    canUseNativeWindowTabTransfers,
    getWindowTabsCapability,
} from '@app/utils/platformWindowTabs';

const { t } = useTypedI18n();
const DIRECTION_ORDER = [
    'right',
    'left',
    'up',
    'down',
] as const satisfies readonly TPaneDirection[];
type TDirectionalAvailabilityKind = 'split' | 'splitEmpty' | 'focus' | 'move' | 'copy';
type TStaticCommandKind = Exclude<TTabContextCommand['kind'], 'split' | 'split-empty' | 'focus' | 'move' | 'copy'>;

interface IContextMenuAction {
    key: string;
    label: string;
    command: TTabContextCommand;
}

interface IContextMenuSection {
    key: string;
    title?: string;
    actions: IContextMenuAction[];
}

type TTabContextMenuItem =
    | {
        type: 'label' | 'separator';
        label?: string;
    }
    | {
        label: string;
        onSelect: () => void;
    };

const {
    contextAvailability = undefined,
    tabs,
} = defineProps<{
    tabs: ITab[];
    activeTabId: string | null;
    contextAvailability?: ITabContextAvailability | null;
}>();

const emit = defineEmits<{
    activate: [id: string];
    close: [id: string];
    'new-tab': [];
    reorder: [fromIndex: number, toIndex: number];
    'move-direction': [tabId: string, direction: 'left' | 'right'];
    'tab-context-command': [tabId: string, command: TTabContextCommand];
}>();

function handleNewTab() {
    emit('new-tab');
}

const tabBarRef = useTemplateRef<HTMLElement>('tabBarRef');
const contextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string | null;
}>({
    visible: false,
    x: 0,
    y: 0,
    tabId: null,
});
const windowTransferTargets = ref<IWindowTabTargetWindow[]>([]);
const canUseNativeWindowTransfers = computed(() => canUseNativeWindowTabTransfers());
const contextMenuAnchorStyle = computed(() => ({
    left: `${contextMenu.value.x}px`,
    top: `${contextMenu.value.y}px`,
}));
const contextMenuOpen = computed({
    get: () => contextMenu.value.visible,
    set: (open: boolean) => {
        if (!open) {
            closeTabContextMenu();
            return;
        }
        contextMenu.value.visible = true;
    },
});
const contextMenuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 0,
    collisionPadding: 8,
    positionStrategy: 'fixed' as const,
    updatePositionStrategy: 'always' as const,
};
const contextMenuUi = {
    content: 'tab-context-menu',
    label: 'tab-context-menu-section',
    separator: 'tab-context-menu-divider',
    item: 'tab-context-menu-action',
};
const canCloseTabs = computed(() => contextAvailability?.canClose ?? true);

function resolveTabTitle(tab: ITab) {
    return getDocumentRefDisplayLabel(tab.originalPath) ?? tab.fileName ?? t('tabs.newTab');
}

function isDirectionEnabled(kind: TDirectionalAvailabilityKind, direction: TPaneDirection) {
    return contextAvailability?.[kind][direction] ?? true;
}

function resolveDirectionalAvailabilityKind(command: TDirectionalTabContextCommand): TDirectionalAvailabilityKind {
    return command.kind === 'split-empty' ? 'splitEmpty' : command.kind;
}

function isDirectionalCommand(command: TTabContextCommand): command is TDirectionalTabContextCommand {
    return 'direction' in command;
}

function isDirectionalCommandEnabled(command: TDirectionalTabContextCommand) {
    return isDirectionEnabled(resolveDirectionalAvailabilityKind(command), command.direction);
}

function isStaticCommandEnabled(command: Exclude<TTabContextCommand, TDirectionalTabContextCommand>) {
    const staticAvailabilityByKind = {
        'new-tab': contextAvailability?.canCreate ?? true,
        'close-tab': contextAvailability?.canClose ?? true,
        'move-to-new-window': canUseNativeWindowTransfers.value && (contextAvailability?.canMoveToNewWindow ?? tabs.length > 1),
        'move-to-window': canUseNativeWindowTransfers.value && (contextAvailability?.canMoveToWindow ?? true),
    } satisfies Record<TStaticCommandKind, boolean>;

    return staticAvailabilityByKind[command.kind];
}

function isCommandEnabled(command: TTabContextCommand) {
    return isDirectionalCommand(command)
        ? isDirectionalCommandEnabled(command)
        : isStaticCommandEnabled(command);
}

function buildDirectionalActions(
    kind: 'split' | 'split-empty' | 'focus' | 'move' | 'copy',
    labels: Record<TPaneDirection, string>,
) {
    return DIRECTION_ORDER.flatMap((direction) => {
        const command: TTabContextCommand = {
            kind,
            direction,
        };
        if (!isCommandEnabled(command)) {
            return [];
        }

        return [{
            key: `${kind}-${direction}`,
            label: labels[direction],
            command,
        } satisfies IContextMenuAction];
    });
}

const primaryActions = computed(() => {
    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'new-tab'})) {
        actions.push({
            key: 'new-tab',
            label: t('tabs.newTab'),
            command: {kind: 'new-tab'},
        });
    }
    if (isCommandEnabled({kind: 'close-tab'})) {
        actions.push({
            key: 'close-tab',
            label: t('tabs.closeTab'),
            command: {kind: 'close-tab'},
        });
    }
    return actions;
});

const windowActions = computed(() => {
    const actions: IContextMenuAction[] = [];
    if (isCommandEnabled({kind: 'move-to-new-window'})) {
        actions.push({
            key: 'move-to-new-window',
            label: t('menu.moveTabToNewWindow'),
            command: {kind: 'move-to-new-window'},
        });
    }

    actions.push(...windowTransferTargets.value.flatMap((targetWindow) => {
        const command = {
            kind: 'move-to-window',
            targetWindowId: targetWindow.windowId,
        } as const;
        if (!isCommandEnabled(command)) {
            return [];
        }

        return [{
            key: `move-to-window-${targetWindow.windowId}`,
            label: `${t('menu.moveTabToWindow')}: ${targetWindow.label}`,
            command,
        }];
    }));

    return actions;
});

const splitActions = computed(() => buildDirectionalActions('split', {
    right: t('menu.splitEditorRight'),
    left: t('menu.splitEditorLeft'),
    up: t('menu.splitEditorUp'),
    down: t('menu.splitEditorDown'),
}));

const splitEmptyActions = computed(() => buildDirectionalActions('split-empty', {
    right: t('menu.newPaneRight'),
    left: t('menu.newPaneLeft'),
    up: t('menu.newPaneUp'),
    down: t('menu.newPaneDown'),
}));

const focusActions = computed(() => buildDirectionalActions('focus', {
    right: t('menu.focusPaneRight'),
    left: t('menu.focusPaneLeft'),
    up: t('menu.focusPaneUp'),
    down: t('menu.focusPaneDown'),
}));

const moveActions = computed(() => buildDirectionalActions('move', {
    right: t('menu.moveTabRight'),
    left: t('menu.moveTabLeft'),
    up: t('menu.moveTabUp'),
    down: t('menu.moveTabDown'),
}));

const copyActions = computed(() => buildDirectionalActions('copy', {
    right: t('menu.copyTabRight'),
    left: t('menu.copyTabLeft'),
    up: t('menu.copyTabUp'),
    down: t('menu.copyTabDown'),
}));

const menuSections = computed(() => {
    const sections: IContextMenuSection[] = [];
    if (primaryActions.value.length > 0) {
        sections.push({
            key: 'primary',
            actions: primaryActions.value,
        });
    }
    if (windowActions.value.length > 0) {
        sections.push({
            key: 'window',
            title: t('menu.window'),
            actions: windowActions.value,
        });
    }
    if (splitActions.value.length > 0) {
        sections.push({
            key: 'split',
            title: t('menu.splitEditor'),
            actions: splitActions.value,
        });
    }
    if (splitEmptyActions.value.length > 0) {
        sections.push({
            key: 'split-empty',
            title: t('menu.newPane'),
            actions: splitEmptyActions.value,
        });
    }
    if (focusActions.value.length > 0) {
        sections.push({
            key: 'focus',
            title: t('menu.focusEditorPane'),
            actions: focusActions.value,
        });
    }
    if (moveActions.value.length > 0) {
        sections.push({
            key: 'move',
            title: t('menu.moveTabToPane'),
            actions: moveActions.value,
        });
    }
    if (copyActions.value.length > 0) {
        sections.push({
            key: 'copy',
            title: t('menu.copyTabToPane'),
            actions: copyActions.value,
        });
    }
    return sections;
});

const contextMenuItems = computed(() => {
    const items: TTabContextMenuItem[] = [];
    for (const section of menuSections.value) {
        if (items.length > 0) {
            items.push({ type: 'separator' });
        }

        if (section.title) {
            items.push({
                type: 'label',
                label: section.title,
            });
        }

        items.push(...section.actions.map(action => ({
            label: action.label,
            onSelect: () => runContextCommand(action.command),
        })));
    }
    return items;
});

const {
    isDragging,
    dragIndex,
    onPointerDown,
    shouldSuppressClick,
} = useTabDragReorder(
    tabBarRef,
    (from, to) => emit('reorder', from, to),
    (index) => {
        const tab = tabs[index];
        if (tab) emit('activate', tab.id);
    },
    (index, direction) => {
        if (!isDirectionEnabled('move', direction)) {
            return;
        }
        const tab = tabs[index];
        if (tab) {
            emit('move-direction', tab.id, direction);
        }
    },
);

function handleTabClick(tabId: string) {
    if (shouldSuppressClick()) {
        return;
    }
    closeTabContextMenu();
    emit('activate', tabId);
}

function handleTabKeydown(event: KeyboardEvent, tabId: string) {
    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    event.preventDefault();
    handleTabClick(tabId);
}

function handleAuxClick(event: MouseEvent, tabId: string) {
    if (event.button === 1 && canCloseTabs.value) {
        emit('close', tabId);
    }
}

function requestClose(tabId: string) {
    if (!canCloseTabs.value) {
        return;
    }
    emit('close', tabId);
}

function closeTabContextMenu() {
    contextMenu.value.visible = false;
    contextMenu.value.tabId = null;
}

async function loadWindowTransferTargets() {
    if (!canUseNativeWindowTransfers.value) {
        windowTransferTargets.value = [];
        return;
    }

    try {
        windowTransferTargets.value = await getWindowTabsCapability().listTargetWindows();
    } catch {
        windowTransferTargets.value = [];
    }
}

function openTabContextMenu(event: MouseEvent, tabId: string) {
    contextMenu.value.visible = true;
    contextMenu.value.tabId = tabId;
    contextMenu.value.x = event.clientX;
    contextMenu.value.y = event.clientY;

    void loadWindowTransferTargets();
}

function runContextCommand(command: TTabContextCommand) {
    const tabId = contextMenu.value.tabId;
    if (!isCommandEnabled(command)) {
        closeTabContextMenu();
        return;
    }
    closeTabContextMenu();
    if (!tabId) {
        return;
    }

    emit('tab-context-command', tabId, command);
}

useEventListener(window, 'resize', () => {
    closeTabContextMenu();
});

useEventListener(window, 'scroll', () => {
    closeTabContextMenu();
}, { capture: true });

useEventListener(window, 'keydown', (event) => {
    if (event.key === 'Escape') {
        closeTabContextMenu();
    }
});

</script>

<style>
.tab-context-menu {
    min-width: min(var(--app-tab-context-menu-min-width), var(--app-floating-panel-viewport-width));
    max-width: min(var(--app-tab-context-menu-max-width), var(--app-floating-panel-viewport-width));
    padding: 0;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    overflow: hidden;
    background: var(--ui-border);
}

.tab-context-menu-divider {
    height: 1px;
    margin: 0;
    background: var(--ui-border);
}

.tab-context-menu-section {
    margin: 0;
    padding: 0.45rem 0.6rem 0.35rem;
    background: var(--ui-bg-muted);
    color: var(--ui-text-dimmed);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    overflow-wrap: anywhere;
}

.tab-context-menu-action {
    width: 100%;
    min-width: 0;
    min-height: 2rem;
    padding: 0.4rem 0.6rem;
    border-radius: 0;
    background: var(--ui-bg);
    color: var(--ui-text);
    font-size: 0.8125rem;
    white-space: normal;
    overflow-wrap: anywhere;
}
</style>

<style scoped>
.tab-bar {
    display: flex;
    align-items: stretch;
    width: 100%;
    min-width: 0;
    height: var(--app-tabbar-height, 2.375rem);
    min-height: var(--app-tabbar-height, 2.375rem);
    background: var(--app-tabbar-bg);
    border-bottom: 1px solid var(--ui-border);
    user-select: none;
    -webkit-app-region: drag;
}

.tab-list {
    display: flex;
    flex: 1;
    width: 100%;
    align-items: stretch;
    overflow: auto hidden;
    min-width: 0;
    scrollbar-width: none;
    padding-left: var(--app-tab-list-start-padding);
}

.tab-list::-webkit-scrollbar {
    display: none;
}

.tab {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.5rem 0 0.75rem;
    min-width: 0;
    max-width: 12.5rem;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--ui-text-dimmed);
    font-size: 0.75rem;
    position: relative;
    touch-action: none;
    -webkit-app-region: no-drag;
    transition: color 0.12s ease, background-color 0.12s ease;
}

.tab:not(.is-active):hover {
    color: var(--ui-text);
    background: var(--app-tab-hover-bg);
}

.tab.is-active {
    color: var(--ui-text);
    background: var(--app-tab-active-bg);
    border-top-left-radius: var(--app-tab-active-radius);
    border-top-right-radius: var(--app-tab-active-radius);
    margin-bottom: -1px;
    z-index: 1;
}

.tab + .tab::before {
    content: '';
    position: absolute;
    left: 0;
    top: 28%;
    bottom: 28%;
    width: 1px;
    background: var(--app-tab-divider);
    pointer-events: none;
    transition: opacity 0.12s ease;
}

.tab.is-active::before,
.tab.is-active + .tab::before,
.tab:hover::before,
.tab:hover + .tab::before {
    opacity: 0;
}

.tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
}

.tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--app-tab-close-size, 1.25rem);
    height: var(--app-tab-close-size, 1.25rem);
    min-width: var(--app-tab-close-size, 1.25rem);
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--ui-text-dimmed);
    opacity: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease;
}

.tab.is-dirty .tab-close {
    opacity: 1;
    color: var(--ui-text-muted);
}

.tab.is-dirty .tab-close :deep(svg),
.tab.is-dirty .tab-close :deep(.iconify) {
    display: none;
}

.tab.is-dirty .tab-close::before {
    content: '';
    display: block;
    width: var(--app-tab-dirty-dot-size, 0.4375rem);
    height: var(--app-tab-dirty-dot-size, 0.4375rem);
    flex: 0 0 var(--app-tab-dirty-dot-size, 0.4375rem);
    border-radius: 50%;
    background: currentcolor;
}

.tab.is-dirty .tab-close:hover:not(:disabled)::before {
    display: none;
}

.tab.is-dirty .tab-close:hover:not(:disabled) :deep(svg),
.tab.is-dirty .tab-close:hover:not(:disabled) :deep(.iconify) {
    display: inline;
}

.tab-close:disabled {
    opacity: 0.35;
}

.tab.is-dirty .tab-close:disabled {
    opacity: 1;
}

.tab:hover .tab-close:not(:disabled),
.tab-close.is-visible:not(:disabled) {
    opacity: 1;
}

/* stylelint-disable-next-line no-descending-specificity */
.tab-close:hover:not(:disabled) {
    opacity: 1;
    background: var(--app-chrome-subtle-hover);
    color: var(--ui-text);
}

.tab-new {
    display: flex;
    align-items: center;
    align-self: center;
    justify-content: center;
    width: var(--app-tab-new-width, 3rem);
    min-width: var(--app-tab-new-width, 3rem);
    height: calc(var(--app-tabbar-height, 2.375rem) - (var(--app-tab-new-block-inset, 0.125rem) * 2));
    margin: var(--app-tab-new-block-inset, 0.125rem) 0.25rem;
    border: none;
    border-radius: var(--app-tab-new-radius, 0.75rem);
    background: transparent;
    color: var(--ui-text-dimmed);
    -webkit-app-region: no-drag;
    transition: background-color 0.12s ease, color 0.12s ease;
}

.tab-new:hover {
    background: var(--app-chrome-subtle-hover);
    color: var(--ui-text);
}

.tab-bar:has(.is-dragging) .tab-list {
    overflow: visible;
}

.tab.is-dragging {
    z-index: 10;
    opacity: 0.7;
}

.tab-context-menu-anchor {
    position: fixed;
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
}
</style>
