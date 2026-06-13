<template>
    <UPopover
        v-model:open="isOpen"
        mode="click"
        :content="contentOptions"
        :reference="triggerRef ?? undefined"
        portal="body"
    >
        <span ref="triggerRef" class="toolbar-popover-trigger">
            <AppTooltip :text="t('toolbar.moreTools')" :delay-duration="1200">
                <UButton
                    :icon="triggerIcon"
                    variant="ghost"
                    color="neutral"
                    class="toolbar-icon-button"
                    :aria-label="t('toolbar.moreTools')"
                    aria-haspopup="menu"
                    :aria-expanded="isOpen"
                />
            </AppTooltip>
        </span>

        <template #content>
            <div class="overflow-menu toolbar-menu-panel">
                <template v-if="hasDocumentItems">
                    <div class="overflow-menu-section-header toolbar-menu-section-header">{{ t('menu.file') }}</div>
                    <div class="overflow-menu-section toolbar-menu-section">
                        <button
                            v-if="canCombineFiles"
                            class="overflow-menu-item toolbar-menu-item"
                            @click="handleMenuCommand('combine-images')"
                        >
                            <UIcon name="i-ph-stack-plus" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('menu.combineFiles') }}</span>
                        </button>
                        <button
                            v-if="canPrintCurrentPage"
                            class="overflow-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint || isDjvuMode"
                            @click="handleMenuCommand('print-current-page')"
                        >
                            <UIcon
                                v-if="isPreparingCurrentPagePrint"
                                name="i-ph-circle-notch"
                                class="overflow-menu-icon toolbar-menu-icon animate-spin"
                            />
                            <PrintCurrentPageIcon v-else class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('menu.printCurrentPage') }}</span>
                        </button>
                        <button
                            v-if="canConvertToPdf"
                            class="overflow-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('convert-to-pdf')"
                        >
                            <UIcon name="i-ph-arrows-clockwise" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('menu.convertToPdf') }}</span>
                        </button>
                    </div>
                </template>

                <template v-if="hasToolItems">
                    <div v-if="hasDocumentItems" class="overflow-menu-divider toolbar-menu-divider" />
                    <div class="overflow-menu-section-header toolbar-menu-section-header">{{ t('toolbar.annotations') }}</div>
                    <div class="overflow-menu-section toolbar-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('capture-region', 3) && canCaptureRegion"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': isCapturingRegion }]"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="handleMenuCommand('capture-region')"
                        >
                            <UIcon name="i-ph-scan" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('toolbar.captureRegion') }}</span>
                            <UIcon
                                v-if="isCapturingRegion"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('crop', 3) && canCrop"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': isCropSelecting }]"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="handleMenuCommand('crop')"
                        >
                            <UIcon name="i-ph-crop" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('toolbar.crop') }}</span>
                            <UIcon
                                v-if="isCropSelecting"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('quick-note', 4) && canQuickNote"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': isPlacingPageNote }]"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="handleMenuCommand('quick-note')"
                        >
                            <UIcon name="i-ph-chat-circle-dots" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('annotations.createNotes') }}</span>
                            <UIcon
                                v-if="isPlacingPageNote"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('ocr', 3) && canUseOcr"
                            class="overflow-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="handleMenuCommand('open-ocr')"
                        >
                            <UIcon name="i-ph-scan" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('ocr.button') }}</span>
                        </button>
                    </div>
                </template>

                <template v-if="hasViewItems">
                    <div v-if="hasDocumentItems || hasToolItems" class="overflow-menu-divider toolbar-menu-divider" />
                    <div class="overflow-menu-section-header toolbar-menu-section-header">{{ t('menu.view') }}</div>
                    <div class="overflow-menu-section toolbar-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('toggle-sidebar')"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': showSidebar }]"
                            :disabled="!hasInteractiveDocument || canToggleSidebar === false"
                            @click="handleMenuCommand('toggle-sidebar')"
                        >
                            <UIcon name="i-ph-sidebar-simple" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('toolbar.toggleSidebar') }}</span>
                            <UIcon
                                v-if="showSidebar"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('view-mode', 2)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': viewMode === 'single' }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleViewModeCommand('single')"
                        >
                            <UIcon name="i-ph-file" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.singlePage') }}</span>
                            <UIcon
                                v-if="viewMode === 'single'"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('view-mode', 2)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': viewMode === 'facing' }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleViewModeCommand('facing')"
                        >
                            <UIcon name="i-ph-book-open" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.facingPages') }}</span>
                            <UIcon
                                v-if="viewMode === 'facing'"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('view-mode', 2)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': viewMode === 'facing-first-single' }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleViewModeCommand('facing-first-single')"
                        >
                            <span class="overflow-menu-icon overflow-menu-icon--facing-first-single">
                                <UIcon name="i-ph-book-open" class="size-[1.125rem]" />
                                <span class="overflow-menu-icon-badge">1</span>
                            </span>
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.facingWithFirstSingle') }}</span>
                            <UIcon
                                v-if="viewMode === 'facing-first-single'"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('fit-width', 3)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': isFitWidthActive }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('fit-width')"
                        >
                            <UIcon name="i-ph-arrows-out-line-horizontal" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.fitWidth') }}</span>
                            <UIcon
                                v-if="isFitWidthActive"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('fit-height', 3)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': isFitHeightActive }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('fit-height')"
                        >
                            <UIcon name="i-ph-arrows-out-line-vertical" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.fitHeight') }}</span>
                            <UIcon
                                v-if="isFitHeightActive"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('continuous-scroll', 2)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': continuousScroll }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('toggle-continuous-scroll')"
                        >
                            <UIcon name="i-ph-scroll" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.continuousScroll') }}</span>
                            <UIcon
                                v-if="continuousScroll"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('drag-mode', 4)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': dragMode }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('enable-drag')"
                        >
                            <UIcon name="i-ph-hand" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.handTool') }}</span>
                            <UIcon
                                v-if="dragMode"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('text-select', 4)"
                            :class="['overflow-menu-item', 'toolbar-menu-item', { 'is-active': !dragMode }]"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('disable-drag')"
                        >
                            <UIcon name="i-ph-cursor-text" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('zoom.textSelect') }}</span>
                            <UIcon
                                v-if="!dragMode"
                                name="i-ph-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('fullscreen')"
                            class="overflow-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || !fullscreenSupported"
                            @click="handleMenuCommand('toggle-fullscreen')"
                        >
                            <UIcon :name="isFullscreen ? 'i-ph-corners-in' : 'i-ph-corners-out'" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('toolbar.fullscreen') }}</span>
                        </button>
                    </div>
                </template>

                <template v-if="hasShellItems">
                    <div v-if="hasDocumentItems || hasToolItems || hasViewItems" class="overflow-menu-divider toolbar-menu-divider" />
                    <div class="overflow-menu-section-header toolbar-menu-section-header">{{ t('toolbar.moreTools') }}</div>
                    <div class="overflow-menu-section toolbar-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('settings')"
                            class="overflow-menu-item toolbar-menu-item"
                            @click="handleMenuCommand('open-settings')"
                        >
                            <UIcon name="i-ph-gear" class="overflow-menu-icon toolbar-menu-icon" />
                            <span class="overflow-menu-label toolbar-menu-label">{{ t('toolbar.settings') }}</span>
                        </button>
                    </div>
                </template>
            </div>
        </template>
    </UPopover>
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

const { t } = useTypedI18n();

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
    canPrintCurrentPage?: boolean
    canConvertToPdf?: boolean
    isPreparingPrint?: boolean
    isPreparingCurrentPagePrint?: boolean
}

const {
    canCaptureRegion,
    canCombineFiles,
    canConvertToPdf,
    canCrop,
    canPrintCurrentPage,
    canQuickNote,
    canUseOcr,
    collapseTier,
    documentBusy,
    fullscreenSupported: fullscreenSupportedProp,
    hasPdf,
    isFullscreen: isFullscreenProp,
    open,
    showDocumentSection,
    surface = undefined,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'open-ocr'): void
    (e: 'toggle-sidebar'): void
    (e: 'fit-width'): void
    (e: 'fit-height'): void
    (e: 'enable-drag'): void
    (e: 'disable-drag'): void
    (e: 'set-view-mode', mode: TPdfViewMode): void
    (e: 'toggle-continuous-scroll'): void
    (e: 'capture-region'): void
    (e: 'crop'): void
    (e: 'quick-note'): void
    (e: 'toggle-fullscreen'): void
    (e: 'open-settings'): void
    (e: 'combine-images'): void
    (e: 'print-current-page'): void
    (e: 'convert-to-pdf'): void
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
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const hasInteractiveDocument = computed(() => hasPdf && documentBusy !== true);
const isFullscreen = computed(() => isFullscreenProp === true);
const fullscreenSupported = computed(() => fullscreenSupportedProp !== false);
const triggerRef = ref<HTMLElement | null>(null);
const contentOptions = {
    side: 'bottom' as const,
    align: 'end' as const,
    sideOffset: 8,
    collisionPadding: 8,
    positionStrategy: 'fixed' as const,
    updatePositionStrategy: 'always' as const,
    hideWhenDetached: true,
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

<style lang="scss" scoped>
@use '@app/assets/css/toolbar-menu-shared';

.overflow-menu {
    min-width: 14rem;
}

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

.overflow-menu-icon--facing-first-single {
    position: relative;
}

.overflow-menu-icon-badge {
    position: absolute;
    top: -0.125rem;
    right: -0.3125rem;
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
    font-size: 0.5625rem;
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
