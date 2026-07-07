<template>
    <UDropdownMenu
        v-model:open="isOpen"
        :items="overflowMenuItems"
        :content="contentOptions"
        :ui="overflowMenuUi"
        portal="body"
    >
        <span class="toolbar-popover-trigger">
            <AppTooltip :text="t('toolbar.moreTools')" :delay-duration="1200">
                <UButton
                    :icon="triggerIcon"
                    variant="ghost"
                    color="neutral"
                    class="toolbar-icon-button"
                    :aria-label="t('toolbar.moreTools')"
                    aria-haspopup="menu"
                    :aria-expanded="hasOverflowMenuCommands ? isOpen : false"
                    :disabled="!hasOverflowMenuCommands"
                />
            </AppTooltip>
        </span>

        <template #print-current-page-leading>
            <UIcon
                v-if="isPreparingCurrentPagePrint"
                name="i-ph-circle-notch"
                class="overflow-menu-icon toolbar-menu-icon animate-spin"
            />
            <PrintCurrentPageIcon v-else class="overflow-menu-icon toolbar-menu-icon" />
        </template>

        <template #facing-first-single-leading>
            <span class="overflow-menu-icon overflow-menu-icon--facing-first-single">
                <UIcon name="i-ph-book-open" class="size-[1.125rem]" />
                <span class="overflow-menu-icon-badge">1</span>
            </span>
        </template>

        <template #item-trailing="{ item }">
            <UIcon
                v-if="isOverflowMenuItemChecked(item)"
                name="i-ph-check"
                class="overflow-menu-check"
            />
        </template>
    </UDropdownMenu>
</template>

<script setup lang="ts">
import type { TPdfViewMode } from '@contracts/shared';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';
import type { TToolbarOverflowMenuCommand } from '@app/types/toolbarMenuCommands';
import {
    isReaderCommandInMenu,
    isReaderCommandInline,
    type TReaderCommandId,
    type IReaderCommandSurface,
} from '@app/utils/readerCommandSurface';
import { getReaderCommandMenuIcon } from '@app/utils/readerCommandIcons';

const { t } = useTypedI18n();

type TToolbarOverflowMenuItem =
    | {
        type: 'label' | 'separator';
        label?: string;
    }
    | IToolbarOverflowMenuCommandItem;

interface IToolbarOverflowMenuCommandItem {
    label: string;
    icon?: string;
    slot?: string;
    disabled?: boolean;
    checked?: boolean;
    class?: string;
    onSelect: () => void;
}

interface IProps {
    open: boolean
    collapseTier: number
    hasPdf: boolean
    canToggleSidebar?: boolean
    canCaptureRegion: boolean
    canCrop: boolean
    canQuickNote: boolean
    canUseOcr: boolean
    showSidebar: boolean
    dragMode: boolean
    continuousScroll: boolean
    viewMode: TPdfViewMode
    isDjvuMode: boolean
    isFitWidthActive: boolean
    isFitHeightActive: boolean
    isCapturingRegion: boolean
    isCropSelecting: boolean
    isPlacingPageNote: boolean
    documentBusy?: boolean
    isFullscreen?: boolean
    fullscreenSupported?: boolean
    surface?: IReaderCommandSurface
    triggerIcon: string
    showDocumentSection?: boolean
    canCombineFiles?: boolean
    canPrint?: boolean
    canPrintCurrentPage?: boolean
    canConvertToPdf?: boolean
    canToggleContinuousScroll?: boolean
    canUseViewModes?: boolean
    isPreparingPrint?: boolean
    isPreparingCurrentPagePrint?: boolean
}

const {
    canCaptureRegion,
    canCombineFiles,
    canConvertToPdf,
    canCrop,
    canPrint = true,
    canPrintCurrentPage,
    canQuickNote,
    canToggleSidebar,
    canToggleContinuousScroll = true,
    canUseViewModes = true,
    canUseOcr,
    collapseTier,
    continuousScroll,
    documentBusy,
    dragMode,
    fullscreenSupported: fullscreenSupportedProp,
    hasPdf,
    isCapturingRegion,
    isCropSelecting,
    isDjvuMode,
    isFitHeightActive,
    isFitWidthActive,
    isFullscreen: isFullscreenProp,
    isPlacingPageNote,
    isPreparingCurrentPagePrint,
    isPreparingPrint,
    open,
    showDocumentSection,
    showSidebar,
    surface = undefined,
    viewMode,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    'open-ocr': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'enable-drag': [];
    'disable-drag': [];
    'set-view-mode': [mode: TPdfViewMode];
    'toggle-continuous-scroll': [];
    'capture-region': [];
    crop: [];
    'quick-note': [];
    'toggle-fullscreen': [];
    'open-settings': [];
    'combine-images': [];
    'print-current-page': [];
    'convert-to-pdf': [];
}>();

const emitMenuCommand = {
    'open-ocr': () => emit('open-ocr'),
    'toggle-sidebar': () => emit('toggle-sidebar'),
    'fit-width': () => emit('fit-width'),
    'fit-height': () => emit('fit-height'),
    'enable-drag': () => emit('enable-drag'),
    'disable-drag': () => emit('disable-drag'),
    'toggle-continuous-scroll': () => emit('toggle-continuous-scroll'),
    'capture-region': () => emit('capture-region'),
    crop: () => emit('crop'),
    'quick-note': () => emit('quick-note'),
    'toggle-fullscreen': () => emit('toggle-fullscreen'),
    'open-settings': () => emit('open-settings'),
    'combine-images': () => emit('combine-images'),
    'print-current-page': () => emit('print-current-page'),
    'convert-to-pdf': () => emit('convert-to-pdf'),
} satisfies Record<TToolbarOverflowMenuCommand, () => void>;

const isOpen = computed({
    get: () => open && hasOverflowMenuCommands.value,
    set: (value: boolean) => emit('update:open', value && hasOverflowMenuCommands.value),
});
const hasInteractiveDocument = computed(() => hasPdf && documentBusy !== true);
const isFullscreen = computed(() => isFullscreenProp === true);
const fullscreenSupported = computed(() => fullscreenSupportedProp !== false);
const contentOptions = {
    side: 'bottom' as const,
    align: 'end' as const,
    sideOffset: 8,
    collisionPadding: 8,
    positionStrategy: 'fixed' as const,
    updatePositionStrategy: 'always' as const,
    hideWhenDetached: true,
};
const overflowMenuUi = {
    content: 'overflow-menu toolbar-menu-panel',
    group: 'overflow-menu-section toolbar-menu-section',
    label: 'overflow-menu-section-header toolbar-menu-section-header',
    separator: 'overflow-menu-divider toolbar-menu-divider',
    item: 'overflow-menu-item toolbar-menu-item',
    itemLeadingIcon: 'overflow-menu-icon toolbar-menu-icon',
    itemLabel: 'overflow-menu-label toolbar-menu-label',
    itemTrailing: 'overflow-menu-trailing',
};

const hasDocumentItems = computed(() => (
    showDocumentSection === true
    && (canCombineFiles === true
        || canPrintCurrentPage === true
        || canConvertToPdf === true)
));

const hasToolItems = computed(() => (
    (canCaptureRegion && shouldShowMenuCommand('capture-region', 3))
    || (canCrop && shouldShowMenuCommand('crop', 3))
    || (canQuickNote && shouldShowMenuCommand('quick-note', 4))
    || (canUseOcr && shouldShowMenuCommand('ocr', 3))
));

const hasViewItems = computed(() => (
    shouldShowMenuCommand('toggle-sidebar')
    || shouldShowMenuCommand('view-mode', 2)
    || shouldShowMenuCommand('fit-width', 3)
    || shouldShowMenuCommand('fit-height', 3)
    || shouldShowMenuCommand('continuous-scroll', 2)
    || shouldShowMenuCommand('drag-mode', 4)
    || shouldShowMenuCommand('text-select', 4)
    || shouldShowMenuCommand('fullscreen')
));

const hasShellItems = computed(() => shouldShowMenuCommand('settings'));

const overflowMenuItems = computed(() => {
    const items: TToolbarOverflowMenuItem[] = [];
    appendMenuSection(items, t('menu.file'), buildDocumentItems());
    appendMenuSection(items, t('toolbar.annotations'), buildToolItems());
    appendMenuSection(items, t('menu.view'), buildViewItems());
    appendMenuSection(items, t('toolbar.moreTools'), buildShellItems());
    return items;
});
const hasOverflowMenuCommands = computed(() => overflowMenuItems.value.some(item => 'onSelect' in item));

watch(hasOverflowMenuCommands, (hasCommands) => {
    if (!hasCommands && open) {
        emit('update:open', false);
    }
});

function close() {
    isOpen.value = false;
}

function handleMenuCommand(command: TToolbarOverflowMenuCommand) {
    emitMenuCommand[command]();
    close();
}

function handleViewModeCommand(mode: TPdfViewMode) {
    emit('set-view-mode', mode);
    close();
}

function buildDocumentItems() {
    const items: IToolbarOverflowMenuCommandItem[] = [];

    if (!hasDocumentItems.value) {
        return items;
    }

    if (canCombineFiles === true) {
        items.push(createCommandItem('combine-images', t('menu.combineFiles'), 'i-ph-stack-plus'));
    }

    if (canPrintCurrentPage === true) {
        items.push(createCommandItem('print-current-page', t('menu.printCurrentPage'), undefined, {
            disabled: !hasInteractiveDocument.value || !canPrint || isPreparingPrint === true,
            slot: 'print-current-page',
        }));
    }

    if (canConvertToPdf === true) {
        items.push(createCommandItem('convert-to-pdf', t('menu.convertToPdf'), 'i-ph-arrows-clockwise', {disabled: !hasInteractiveDocument.value}));
    }

    return items;
}

function buildToolItems() {
    const items: IToolbarOverflowMenuCommandItem[] = [];

    if (!hasToolItems.value) {
        return items;
    }

    if (canCaptureRegion && shouldShowMenuCommand('capture-region', 3)) {
        items.push(createReaderCommandItem('capture-region', 'capture-region', t('toolbar.captureRegion'), {
            checked: isCapturingRegion,
            disabled: !hasInteractiveDocument.value || isDjvuMode,
        }));
    }

    if (canCrop && shouldShowMenuCommand('crop', 3)) {
        items.push(createReaderCommandItem('crop', 'crop', t('toolbar.crop'), {
            checked: isCropSelecting,
            disabled: !hasInteractiveDocument.value || isDjvuMode,
        }));
    }

    if (canQuickNote && shouldShowMenuCommand('quick-note', 4)) {
        items.push(createReaderCommandItem('quick-note', 'quick-note', t('annotations.createNotes'), {
            checked: isPlacingPageNote,
            disabled: !hasInteractiveDocument.value || isDjvuMode,
        }));
    }

    if (canUseOcr && shouldShowMenuCommand('ocr', 3)) {
        items.push(createReaderCommandItem('ocr', 'open-ocr', t('ocr.button'), {disabled: !hasInteractiveDocument.value || isDjvuMode}));
    }

    return items;
}

function buildViewItems() {
    const items: IToolbarOverflowMenuCommandItem[] = [];

    if (!hasViewItems.value) {
        return items;
    }

    if (shouldShowMenuCommand('toggle-sidebar')) {
        items.push(createReaderCommandItem('toggle-sidebar', 'toggle-sidebar', t('toolbar.toggleSidebar'), {
            checked: showSidebar,
            disabled: !hasInteractiveDocument.value || canToggleSidebar === false,
        }));
    }

    if (canUseViewModes && shouldShowMenuCommand('view-mode', 2)) {
        items.push(
            createViewModeItem('single', t('zoom.singlePage'), 'i-ph-file'),
            createViewModeItem('facing', t('zoom.facingPages'), 'i-ph-book-open'),
            createViewModeItem('facing-first-single', t('zoom.facingWithFirstSingle'), undefined, 'facing-first-single'),
        );
    }

    if (shouldShowMenuCommand('fit-width', 3)) {
        items.push(createReaderCommandItem('fit-width', 'fit-width', t('zoom.fitWidth'), {
            checked: isFitWidthActive,
            disabled: !hasInteractiveDocument.value,
        }));
    }

    if (shouldShowMenuCommand('fit-height', 3)) {
        items.push(createReaderCommandItem('fit-height', 'fit-height', t('zoom.fitHeight'), {
            checked: isFitHeightActive,
            disabled: !hasInteractiveDocument.value,
        }));
    }

    if (canToggleContinuousScroll && shouldShowMenuCommand('continuous-scroll', 2)) {
        items.push(createReaderCommandItem('continuous-scroll', 'toggle-continuous-scroll', t('zoom.continuousScroll'), {
            checked: continuousScroll,
            disabled: !hasInteractiveDocument.value,
        }));
    }

    if (shouldShowMenuCommand('drag-mode', 4)) {
        items.push(createReaderCommandItem('drag-mode', 'enable-drag', t('zoom.handTool'), {
            checked: dragMode && !isPlacingPageNote,
            disabled: !hasInteractiveDocument.value,
        }));
    }

    if (shouldShowMenuCommand('text-select', 4)) {
        items.push(createReaderCommandItem('text-select', 'disable-drag', t('zoom.textSelect'), {
            checked: !dragMode && !isPlacingPageNote,
            disabled: !hasInteractiveDocument.value,
        }));
    }

    if (shouldShowMenuCommand('fullscreen')) {
        items.push(createCommandItem(
            'toggle-fullscreen',
            t('toolbar.fullscreen'),
            isFullscreen.value ? 'i-ph-corners-in' : getReaderCommandMenuIcon('fullscreen'),
            {disabled: !hasInteractiveDocument.value || !fullscreenSupported.value},
        ));
    }

    return items;
}

function buildShellItems() {
    if (!hasShellItems.value) {
        return [];
    }

    return [createReaderCommandItem('settings', 'open-settings', t('toolbar.settings'))];
}

function appendMenuSection(
    target: TToolbarOverflowMenuItem[],
    label: string,
    sectionItems: IToolbarOverflowMenuCommandItem[],
) {
    if (sectionItems.length === 0) {
        return;
    }

    if (target.length > 0) {
        target.push({ type: 'separator' });
    }

    target.push(
        {
            type: 'label',
            label,
        },
        ...sectionItems,
    );
}

function createCommandItem(
    command: TToolbarOverflowMenuCommand,
    label: string,
    icon?: string,
    options: {
        checked?: boolean;
        disabled?: boolean;
        slot?: string;
    } = {},
): IToolbarOverflowMenuCommandItem {
    const item: IToolbarOverflowMenuCommandItem = {
        label,
        onSelect: () => handleMenuCommand(command),
    };

    if (icon !== undefined) {
        item.icon = icon;
    }

    applyMenuItemOptions(item, options);
    return item;
}

function createReaderCommandItem(
    readerCommand: TReaderCommandId,
    command: TToolbarOverflowMenuCommand,
    label: string,
    options: {
        checked?: boolean;
        disabled?: boolean;
        slot?: string;
    } = {},
) {
    return createCommandItem(command, label, getReaderCommandMenuIcon(readerCommand), options);
}

function createViewModeItem(
    mode: TPdfViewMode,
    label: string,
    icon?: string,
    slot?: string,
) {
    const item: IToolbarOverflowMenuCommandItem = {
        label,
        checked: viewMode === mode,
        disabled: !hasInteractiveDocument.value,
        onSelect: () => handleViewModeCommand(mode),
    };

    if (icon !== undefined) {
        item.icon = icon;
    }

    if (slot !== undefined) {
        item.slot = slot;
    }

    if (item.checked) {
        item.class = 'is-active';
    }

    return item;
}

function applyMenuItemOptions(
    item: IToolbarOverflowMenuCommandItem,
    options: {
        checked?: boolean;
        disabled?: boolean;
        slot?: string;
    },
) {
    if (options.checked !== undefined) {
        item.checked = options.checked;
    }

    if (options.disabled !== undefined) {
        item.disabled = options.disabled;
    }

    if (options.slot !== undefined) {
        item.slot = options.slot;
    }

    if (item.checked) {
        item.class = 'is-active';
    }
}

function isOverflowMenuItemChecked(item: unknown) {
    return typeof item === 'object' && item != null && 'checked' in item
        ? item.checked === true
        : false;
}

function shouldShowMenuCommand(command: TReaderCommandId, requiredCollapseTier = Number.POSITIVE_INFINITY) {
    if (!isReaderCommandInMenu(surface, command)) {
        return false;
    }

    if (!isReaderCommandInline(surface, command)) {
        return true;
    }

    return collapseTier >= requiredCollapseTier;
}
</script>

<style lang="scss">
@use '@app/assets/css/toolbar-menu-shared';

.overflow-menu {
    min-width: min(var(--app-toolbar-overflow-menu-min-width), var(--app-floating-panel-viewport-width));
}

.overflow-menu-icon--facing-first-single {
    position: relative;
}

.overflow-menu-icon-badge {
    position: absolute;
    top: var(--app-toolbar-overflow-badge-offset-top);
    right: var(--app-toolbar-overflow-badge-offset-inline-end);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--app-space-9xl);
    height: var(--app-space-9xl);
    padding: 0 var(--app-space-3xs);
    border-radius: var(--app-radius-full);
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-toolbar-overflow-badge-font-size);
    line-height: var(--app-line-height-tight);
    font-weight: 700;
}

.overflow-menu-item.is-active .overflow-menu-icon-badge {
    color: var(--ui-text);
}

.overflow-menu-check {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
    color: var(--ui-text);
    flex-shrink: 0;
}
</style>

<style lang="scss" scoped>

.toolbar-icon-button {
    width: var(--toolbar-control-height, 2.25rem);
    height: var(--toolbar-control-height, 2.25rem);
    border: 1px solid transparent;
    border-radius: var(--app-toolbar-button-radius);
    color: var(--app-toolbar-control-inactive-fg);
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease;
}

.toolbar-icon-button:hover,
.toolbar-icon-button[aria-expanded='true'] {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-icon-button[aria-expanded='true'] {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
}

.toolbar-icon-button[aria-expanded='true']:hover {
    background: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
}

.toolbar-popover-trigger {
    display: inline-flex;
}
</style>
