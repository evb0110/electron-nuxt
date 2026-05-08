<template>
    <header ref="toolbarRef" :class="['toolbar', `toolbar--${variant}`]">
        <div class="toolbar-section toolbar-left">
            <slot
                v-if="isCommandInline('app-menu')"
                name="app-menu"
                :collapse-tier="collapseTier"
                :has-overflow-items="hasOverflowItems"
                :is-collapsed="isCollapsed"
            />
            <div v-if="isCommandInline('app-menu') && $slots['app-menu']" class="toolbar-separator" />
            <ToolbarButton
                v-if="isCommandInline('open-file')"
                icon="lucide:folder-open"
                :tooltip="t('toolbar.openPdf')"
                :shortcut="shortcutLabels.openFile"
                :disabled="isOpeningDocument"
                :loading="isOpeningDocument"
                @click="emit('open-file')"
            />
            <div class="toolbar-separator" />
            <ToolbarButton
                v-if="isCommandInline('toggle-sidebar')"
                icon="lucide:panel-left"
                :active="showSidebar"
                :tooltip="t('toolbar.toggleSidebar')"
                :shortcut="shortcutLabels.toggleSidebar"
                :disabled="!hasInteractiveDocument || canToggleSidebar === false"
                @click="emit('toggle-sidebar')"
            />

            <div class="toolbar-separator" />

            <template v-if="!isCollapsed(3)">
                <ToolbarButton
                    v-if="isCommandInline('save')"
                    icon="lucide:save"
                    :tooltip="t('toolbar.save')"
                    :shortcut="shortcutLabels.save"
                    :disabled="!hasInteractiveDocument || !canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                    :loading="isSaving"
                    @click="emit('save')"
                />
                <ToolbarButton
                    v-if="isCommandInline('save-as')"
                    icon="lucide:save-all"
                    :tooltip="t('toolbar.saveAs')"
                    :shortcut="shortcutLabels.saveAs"
                    :disabled="!hasInteractiveDocument || isAnySaving || isHistoryBusy || isDjvuMode"
                    :loading="isSavingAs"
                    @click="emit('save-as')"
                />
                <ToolbarButton
                    v-if="isCommandInline('print')"
                    icon="lucide:printer"
                    :tooltip="t('toolbar.print')"
                    :shortcut="shortcutLabels.print"
                    :disabled="!hasInteractiveDocument || isAnySaving || isHistoryBusy || isDjvuMode"
                    :loading="isPreparingPrint && !isPreparingCurrentPagePrint"
                    @click="emit('print')"
                />
                <ToolbarButton
                    v-if="isCommandInline('print-current-page')"
                    icon="lucide:printer"
                    :tooltip="t('toolbar.printCurrentPage')"
                    :disabled="!hasInteractiveDocument || isAnySaving || isHistoryBusy || isDjvuMode"
                    :loading="isPreparingCurrentPagePrint"
                    @click="emit('print-current-page')"
                >
                    <PrintCurrentPageIcon class="size-full" />
                </ToolbarButton>
            </template>

            <div class="toolbar-separator" />

            <template v-if="!isCollapsed(3)">
                <ToolbarButton
                    v-if="isCommandInline('undo')"
                    icon="lucide:undo-2"
                    :tooltip="t('toolbar.undo')"
                    :shortcut="shortcutLabels.undo"
                    :disabled="!hasInteractiveDocument || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                    @click="emit('undo')"
                />
                <ToolbarButton
                    v-if="isCommandInline('redo')"
                    icon="lucide:redo-2"
                    :tooltip="t('toolbar.redo')"
                    :shortcut="shortcutLabels.redo"
                    :disabled="!hasInteractiveDocument || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                    @click="emit('redo')"
                />
            </template>
        </div>

        <div class="toolbar-separator" />

        <div class="toolbar-section toolbar-center">
            <div class="toolbar-inline-group">
                <slot
                    v-if="isCommandInline('page-navigation')"
                    name="page-dropdown"
                    :collapse-tier="collapseTier"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />
            </div>

            <div class="toolbar-separator" />

            <div class="toolbar-inline-group">
                <slot
                    v-if="isCommandInline('zoom')"
                    name="zoom-dropdown"
                    :collapse-tier="collapseTier"
                    :has-overflow-items="hasOverflowItems"
                    :is-collapsed="isCollapsed"
                />
            </div>

            <div class="toolbar-separator" />

            <div v-if="!isCollapsed(2)" class="toolbar-button-group">
                <div v-if="isCommandInline('fit-width')" class="toolbar-group-item">
                    <ToolbarButton
                        icon="lucide:move-horizontal"
                        :active="isFitWidthActive"
                        :tooltip="t('zoom.fitWidth')"
                        :shortcut="shortcutLabels.fitWidth"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="emit('fit-width')"
                    />
                </div>
                <div v-if="isCommandInline('fit-height')" class="toolbar-group-item">
                    <ToolbarButton
                        icon="lucide:move-vertical"
                        :active="isFitHeightActive"
                        :tooltip="t('zoom.fitHeight')"
                        :shortcut="shortcutLabels.fitHeight"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="emit('fit-height')"
                    />
                </div>
                <div v-if="isCommandInline('continuous-scroll') && !isCollapsed(1)" class="toolbar-group-item">
                    <ToolbarButton
                        icon="lucide:scroll"
                        :active="continuousScroll"
                        :tooltip="t('zoom.continuousScroll')"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="emit('toggle-continuous-scroll')"
                    />
                </div>
            </div>

            <div class="toolbar-separator" />

            <ToolbarButton
                v-if="isCommandInline('quick-note') && isCollapsed(2)"
                icon="lucide:message-square-plus"
                :active="isPlacingPageNote"
                :tooltip="isPlacingPageNote ? t('annotations.placeHint') : t('annotations.stickyDescription')"
                :disabled="!hasInteractiveDocument || isDjvuMode"
                @click="emit('quick-note')"
            />

            <div v-else class="toolbar-button-group">
                <div v-if="isCommandInline('quick-note')" class="toolbar-group-item">
                    <ToolbarButton
                        icon="lucide:message-square-plus"
                        :active="isPlacingPageNote"
                        :tooltip="isPlacingPageNote ? t('annotations.placeHint') : t('annotations.stickyDescription')"
                        :disabled="!hasInteractiveDocument || isDjvuMode"
                        grouped
                        @click="emit('quick-note')"
                    />
                </div>
                <div v-if="isCommandInline('drag-mode')" class="toolbar-group-item">
                    <ToolbarButton
                        icon="lucide:hand"
                        :active="dragMode && !isPlacingPageNote"
                        :tooltip="t('zoom.handTool')"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="emit('enable-drag')"
                    />
                </div>
                <div v-if="isCommandInline('text-select')" class="toolbar-group-item">
                    <ToolbarButton
                        icon="lucide:text-cursor"
                        :active="!dragMode && !isPlacingPageNote"
                        :tooltip="t('zoom.textSelect')"
                        :disabled="!hasInteractiveDocument"
                        grouped
                        @click="emit('disable-drag')"
                    />
                </div>
            </div>
        </div>

        <div class="toolbar-separator" />

        <div class="toolbar-section toolbar-right">
            <ToolbarButton
                v-if="isCommandInline('capture-region') && !isCollapsed(2)"
                icon="lucide:scan"
                :active="isCapturingRegion"
                :tooltip="t('toolbar.captureRegion')"
                :disabled="!hasInteractiveDocument"
                @click="emit('capture-region')"
            />
            <ToolbarButton
                v-if="isCommandInline('crop') && !isCollapsed(2)"
                icon="lucide:crop"
                :active="isCropSelecting"
                :tooltip="t('toolbar.crop')"
                :disabled="!hasInteractiveDocument || isDjvuMode"
                @click="emit('crop')"
            />

            <slot
                v-if="isCommandInline('ocr')"
                name="ocr"
                :collapse-tier="collapseTier"
                :has-overflow-items="hasOverflowItems"
                :is-collapsed="isCollapsed"
            />

            <ToolbarButton
                v-if="isCommandInline('export-docx') && !isCollapsed(1)"
                icon="lucide:file-text"
                :tooltip="t('toolbar.exportDocx')"
                :shortcut="shortcutLabels.exportDocx"
                :disabled="!hasInteractiveDocument || !canExportDocx || isAnySaving || isHistoryBusy || isExportingDocx"
                :loading="isExportingDocx"
                @click="emit('export-docx')"
            />

            <div v-if="!isCollapsed(2)" class="toolbar-separator" />

            <slot
                v-if="isCommandInline('overflow-menu')"
                name="overflow-menu"
                :collapse-tier="collapseTier"
                :has-overflow-items="hasOverflowItems"
                :is-collapsed="isCollapsed"
            />
            <ToolbarButton
                v-if="isCommandInline('fullscreen')"
                :icon="isFullscreen ? 'lucide:shrink' : 'lucide:expand'"
                :tooltip="t('toolbar.fullscreen')"
                :active="isFullscreen"
                :disabled="!fullscreenSupported"
                @click="toggleFullscreen()"
            />
            <ToolbarButton
                v-if="isCommandInline('settings')"
                icon="lucide:settings"
                :tooltip="t('toolbar.settings')"
                @click="emit('open-settings')"
            />
        </div>
    </header>
</template>

<script setup lang="ts">
import ToolbarButton from '@app/components/ToolbarButton.vue';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';
import { getShortcutLabels } from '@app/constants/shortcuts';
import {
    isReaderCommandInline,
    type TReaderCommandId,
    type IReaderCommandSurface,
} from '@app/utils/reader-command-surface';

const {
    hasPdf,
    surface = undefined,
    variant = 'editor',
    documentBusy = false,
} = defineProps<{
    hasPdf: boolean;
    variant?: 'editor' | 'reader';
    documentBusy?: boolean;
    canToggleSidebar?: boolean;
    canSave: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canExportDocx: boolean;
    isSaving: boolean;
    isSavingAs: boolean;
    isAnySaving: boolean;
    isHistoryBusy: boolean;
    isExportingDocx: boolean;
    isOpeningDocument?: boolean;
    isPreparingPrint?: boolean;
    isPreparingCurrentPagePrint?: boolean;
    isFitWidthActive: boolean;
    isFitHeightActive: boolean;
    showSidebar: boolean;
    dragMode: boolean;
    isCapturingRegion: boolean;
    isCropSelecting: boolean;
    isPlacingPageNote: boolean;
    continuousScroll: boolean;
    isDjvuMode?: boolean;
    surface?: IReaderCommandSurface;
}>();

const emit = defineEmits<{
    'open-file': [];
    'open-settings': [];
    'save': [];
    'save-as': [];
    'print': [];
    'print-current-page': [];
    'export-docx': [];
    'undo': [];
    'redo': [];
    'toggle-sidebar': [];
    'fit-width': [];
    'fit-height': [];
    'toggle-continuous-scroll': [];
    'enable-drag': [];
    'disable-drag': [];
    'capture-region': [];
    'crop': [];
    'quick-note': [];
}>();

const { t } = useTypedI18n();

const {
    toolbarRef,
    collapseTier,
    hasOverflowItems,
    isCollapsed,
} = useToolbarOverflow();

const {
    isFullscreen,
    isSupported: fullscreenSupported,
    toggleFullscreen,
} = useFullscreen();

const shortcutLabels = getShortcutLabels();
const hasInteractiveDocument = computed(() => hasPdf && !documentBusy);

function isCommandInline(command: TReaderCommandId) {
    return isReaderCommandInline(surface, command);
}
</script>

<style scoped>
/*
 * Toolbar layout
 * ──────────────
 * All interactive controls share --toolbar-control-height (2rem / 32px).
 *
 * Two button types:
 *   1. ToolbarButton  — native <button> with <Icon>. Handles sizing, hover, disabled,
 *      focus, toggle (active), loading, and grouped states internally via scoped CSS.
 *   2. Zoom/Page controls — composite widgets in their own components, using
 *      ToolbarButton for icon buttons and native elements for displays/inputs.
 */
.toolbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 0.65rem;
    border-bottom: 1px solid var(--ui-border);
    background:
        linear-gradient(
            180deg,
            color-mix(in oklab, var(--app-chrome) 90%, var(--ui-bg) 10%) 0%,
            var(--app-chrome) 100%
        );
    box-shadow: var(--app-chrome-depth);
    white-space: nowrap;
    overflow: hidden;
    position: relative;
    z-index: 10;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    --toolbar-control-height: 2.25rem;
    --toolbar-icon-size: 18px;
}

.toolbar-section {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
}

.toolbar-left {
    flex-shrink: 0;
}

.toolbar-center {
    flex: 1;
    min-width: 0;
    justify-content: center;
    gap: 0.4rem;
    overflow: hidden;
}

.toolbar-right {
    flex-shrink: 0;
}

.toolbar-separator {
    width: 1px;
    height: 1.25rem;
    background: color-mix(in oklab, var(--ui-border) 60%, transparent 40%);
    flex-shrink: 0;
    margin: 0 0.25rem;
}

.toolbar-separator:first-child,
.toolbar-separator:last-child,
.toolbar-separator + .toolbar-separator {
    display: none;
}

.toolbar-button-group {
    display: flex;
    align-items: center;
    gap: 0.1rem;
    flex-shrink: 0;
    min-width: max-content;
}

.toolbar-group-item {
    display: flex;
}

.toolbar-inline-group {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
    min-width: max-content;
}

.toolbar--reader {
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    justify-content: space-between;
}

.toolbar--reader .toolbar-separator {
    display: none;
}

.toolbar--reader .toolbar-left,
.toolbar--reader .toolbar-center,
.toolbar--reader .toolbar-right {
    gap: 0.5rem;
}

.toolbar--reader .toolbar-center {
    flex: 0 1 auto;
}

.toolbar--reader .toolbar-left,
.toolbar--reader .toolbar-right {
    min-width: 0;
}
</style>
