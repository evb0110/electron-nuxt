<template>
    <UPopover
        v-model:open="isOpen"
        mode="click"
        :content="{ side: 'bottom', align: 'end', sideOffset: 8, collisionPadding: 8 }"
    >
        <UTooltip :text="t('toolbar.moreTools')" :delay-duration="1200">
            <UButton
                :icon="triggerIcon"
                variant="ghost"
                color="neutral"
                class="toolbar-icon-button"
                :aria-label="t('toolbar.moreTools')"
                aria-haspopup="menu"
                :aria-expanded="isOpen"
            />
        </UTooltip>

        <template #content>
            <div class="overflow-menu">
                <template v-if="hasDocumentItems">
                    <div class="overflow-menu-section-header">{{ t('menu.file') }}</div>
                    <div class="overflow-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('print', 3) && canPrint"
                            class="overflow-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint || isDjvuMode"
                            @click="emit('print'); close()"
                        >
                            <UIcon
                                :name="isPreparingPrint && !isPreparingCurrentPagePrint ? 'i-lucide-loader-circle' : 'i-lucide-printer'"
                                :class="['overflow-menu-icon', { 'animate-spin': isPreparingPrint && !isPreparingCurrentPagePrint }]"
                            />
                            <span class="overflow-menu-label">{{ t('toolbar.print') }}</span>
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('print-current-page', 3)"
                            class="overflow-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint || isDjvuMode"
                            @click="emit('print-current-page'); close()"
                        >
                            <UIcon
                                v-if="isPreparingCurrentPagePrint"
                                name="i-lucide-loader-circle"
                                class="overflow-menu-icon animate-spin"
                            />
                            <PrintCurrentPageIcon v-else class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.printCurrentPage') }}</span>
                        </button>
                    </div>
                </template>

                <template v-if="hasToolItems">
                    <div v-if="hasDocumentItems" class="overflow-menu-divider" />
                    <div class="overflow-menu-section-header">{{ t('toolbar.annotations') }}</div>
                    <div class="overflow-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('capture-region', 2) && canCaptureRegion"
                            :class="['overflow-menu-item', { 'is-active': isCapturingRegion }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('capture-region'); close()"
                        >
                            <UIcon name="i-lucide-scan" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.captureRegion') }}</span>
                            <UIcon
                                v-if="isCapturingRegion"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('crop', 2) && canCrop"
                            :class="['overflow-menu-item', { 'is-active': isCropSelecting }]"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="emit('crop'); close()"
                        >
                            <UIcon name="i-lucide-crop" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.crop') }}</span>
                            <UIcon
                                v-if="isCropSelecting"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('quick-note', 2) && canQuickNote"
                            :class="['overflow-menu-item', { 'is-active': isPlacingPageNote }]"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="emit('quick-note'); close()"
                        >
                            <UIcon name="i-lucide-message-square-plus" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('annotations.createNotes') }}</span>
                            <UIcon
                                v-if="isPlacingPageNote"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('ocr', 2) && canUseOcr"
                            class="overflow-menu-item"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="emit('open-ocr'); close()"
                        >
                            <UIcon name="i-lucide-scan-text" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('ocr.button') }}</span>
                        </button>
                    </div>
                </template>

                <template v-if="hasViewItems">
                    <div v-if="hasToolItems" class="overflow-menu-divider" />
                    <div class="overflow-menu-section-header">{{ t('menu.view') }}</div>
                    <div class="overflow-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('toggle-sidebar')"
                            :class="['overflow-menu-item', { 'is-active': showSidebar }]"
                            :disabled="!hasInteractiveDocument || canToggleSidebar === false"
                            @click="emit('toggle-sidebar'); close()"
                        >
                            <UIcon name="i-lucide-panel-left" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.toggleSidebar') }}</span>
                            <UIcon
                                v-if="showSidebar"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('view-mode', 2)"
                            :class="['overflow-menu-item', { 'is-active': viewMode === 'single' }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('set-view-mode', 'single'); close()"
                        >
                            <UIcon name="i-lucide-file" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.singlePage') }}</span>
                            <UIcon
                                v-if="viewMode === 'single'"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('view-mode', 2)"
                            :class="['overflow-menu-item', { 'is-active': viewMode === 'facing' }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('set-view-mode', 'facing'); close()"
                        >
                            <UIcon name="i-lucide-book-open" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.facingPages') }}</span>
                            <UIcon
                                v-if="viewMode === 'facing'"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('view-mode', 2)"
                            :class="['overflow-menu-item', { 'is-active': viewMode === 'facing-first-single' }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('set-view-mode', 'facing-first-single'); close()"
                        >
                            <span class="overflow-menu-icon overflow-menu-icon--facing-first-single">
                                <UIcon name="i-lucide-book-open" class="size-[1.125rem]" />
                                <span class="overflow-menu-icon-badge">1</span>
                            </span>
                            <span class="overflow-menu-label">{{ t('zoom.facingWithFirstSingle') }}</span>
                            <UIcon
                                v-if="viewMode === 'facing-first-single'"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('fit-width', 2)"
                            :class="['overflow-menu-item', { 'is-active': isFitWidthActive }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('fit-width'); close()"
                        >
                            <UIcon name="i-lucide-move-horizontal" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.fitWidth') }}</span>
                            <UIcon
                                v-if="isFitWidthActive"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('fit-height', 2)"
                            :class="['overflow-menu-item', { 'is-active': isFitHeightActive }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('fit-height'); close()"
                        >
                            <UIcon name="i-lucide-move-vertical" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.fitHeight') }}</span>
                            <UIcon
                                v-if="isFitHeightActive"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('continuous-scroll', 1)"
                            :class="['overflow-menu-item', { 'is-active': continuousScroll }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('toggle-continuous-scroll'); close()"
                        >
                            <UIcon name="i-lucide-scroll" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.continuousScroll') }}</span>
                            <UIcon
                                v-if="continuousScroll"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('drag-mode', 2)"
                            :class="['overflow-menu-item', { 'is-active': dragMode }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('enable-drag'); close()"
                        >
                            <UIcon name="i-lucide-hand" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.handTool') }}</span>
                            <UIcon
                                v-if="dragMode"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('text-select', 2)"
                            :class="['overflow-menu-item', { 'is-active': !dragMode }]"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('disable-drag'); close()"
                        >
                            <UIcon name="i-lucide-text-cursor" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('zoom.textSelect') }}</span>
                            <UIcon
                                v-if="!dragMode"
                                name="i-lucide-check"
                                class="overflow-menu-check"
                            />
                        </button>
                        <button
                            v-if="shouldShowMenuCommand('fullscreen')"
                            class="overflow-menu-item"
                            :disabled="!fullscreenSupported"
                            @click="toggleFullscreen(); close()"
                        >
                            <UIcon :name="isFullscreen ? 'i-lucide-shrink' : 'i-lucide-expand'" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.fullscreen') }}</span>
                        </button>
                    </div>
                </template>

                <template v-if="hasShellItems">
                    <div v-if="hasToolItems || hasViewItems" class="overflow-menu-divider" />
                    <div class="overflow-menu-section-header">{{ t('toolbar.moreTools') }}</div>
                    <div class="overflow-menu-section">
                        <button
                            v-if="shouldShowMenuCommand('settings')"
                            class="overflow-menu-item"
                            @click="emit('open-settings'); close()"
                        >
                            <UIcon name="i-lucide-settings" class="overflow-menu-icon" />
                            <span class="overflow-menu-label">{{ t('toolbar.settings') }}</span>
                        </button>
                    </div>
                </template>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type { TPdfViewMode } from '@contracts/shared';
import {
    isReaderCommandInMenu,
    isReaderCommandInline,
    type TReaderCommandId,
    type IReaderCommandSurface,
} from '@app/utils/reader-command-surface';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';

const { t } = useTypedI18n();

interface IProps {
    open: boolean
    collapseTier: number
    hasPdf: boolean
    canSave: boolean
    canSaveAs: boolean
    canPrint: boolean
    canUndo: boolean
    canRedo: boolean
    canToggleSidebar?: boolean
    canCaptureRegion: boolean
    canCrop: boolean
    canQuickNote: boolean
    isAnySaving: boolean
    isHistoryBusy: boolean
    isExportingDocx: boolean
    isPreparingPrint?: boolean
    isPreparingCurrentPagePrint?: boolean
    canExportDocx: boolean
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
    surface?: IReaderCommandSurface
    triggerIcon: string
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'save'): void
    (e: 'save-as'): void
    (e: 'print'): void
    (e: 'print-current-page'): void
    (e: 'export-docx'): void
    (e: 'open-file'): void
    (e: 'open-ocr'): void
    (e: 'undo'): void
    (e: 'redo'): void
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
    (e: 'open-settings'): void
}>();

const {
    isFullscreen,
    isSupported: fullscreenSupported,
    toggleFullscreen,
} = useFullscreen();

const isOpen = computed({
    get: () => props.open,
    set: (value: boolean) => emit('update:open', value),
});
const hasInteractiveDocument = computed(() => props.hasPdf && props.documentBusy !== true);

const hasDocumentItems = computed(() => (
    (props.canPrint && shouldShowMenuCommand('print', 3))
    || shouldShowMenuCommand('print-current-page', 3)
));

const hasToolItems = computed(() => (
    (props.canCaptureRegion && shouldShowMenuCommand('capture-region', 2))
    || (props.canCrop && shouldShowMenuCommand('crop', 2))
    || (props.canQuickNote && shouldShowMenuCommand('quick-note', 2))
    || (props.canUseOcr && shouldShowMenuCommand('ocr', 2))
));

const hasViewItems = computed(() => (
    shouldShowMenuCommand('toggle-sidebar')
    || shouldShowMenuCommand('view-mode', 2)
    || shouldShowMenuCommand('fit-width', 2)
    || shouldShowMenuCommand('fit-height', 2)
    || shouldShowMenuCommand('continuous-scroll', 1)
    || shouldShowMenuCommand('drag-mode', 2)
    || shouldShowMenuCommand('text-select', 2)
    || shouldShowMenuCommand('fullscreen')
));

const hasShellItems = computed(() => shouldShowMenuCommand('settings'));

function close() {
    isOpen.value = false;
}

function shouldShowMenuCommand(command: TReaderCommandId, collapseTier = Number.POSITIVE_INFINITY) {
    if (!isReaderCommandInMenu(props.surface, command)) {
        return false;
    }

    if (!isReaderCommandInline(props.surface, command)) {
        return true;
    }

    return props.collapseTier >= collapseTier;
}
</script>

<style scoped>
.overflow-menu {
    padding: 0.25rem;
    min-width: 14rem;
}

.overflow-menu-section {
    display: flex;
    flex-direction: column;
}

.overflow-menu-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.overflow-menu-section-header {
    padding: 0.5rem 0.75rem 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ui-text-muted);
}

.overflow-menu-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 0.375rem;
    color: var(--ui-text);
    font-size: 0.875rem;
    text-align: left;
    transition: background-color 150ms ease;
}

.overflow-menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.overflow-menu-item:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.overflow-menu-item.is-active {
    color: var(--ui-text);
}

.overflow-menu-icon {
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    color: var(--ui-text-muted);
}

.overflow-menu-item.is-active .overflow-menu-icon {
    color: var(--ui-text);
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
    min-width: 0.75rem;
    height: 0.75rem;
    padding: 0 0.125rem;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.5625rem;
    line-height: 1;
    font-weight: 700;
}

.overflow-menu-item.is-active .overflow-menu-icon-badge {
    color: var(--ui-text);
}

.overflow-menu-label {
    flex: 1;
}

.overflow-menu-shortcut {
    margin-left: 1rem;
    flex-shrink: 0;
    color: var(--ui-text-muted);
    font-size: 0.75rem;
}

.overflow-menu-check {
    width: 1rem;
    height: 1rem;
    color: var(--ui-text);
    flex-shrink: 0;
}
</style>
