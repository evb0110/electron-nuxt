<template>
    <UPopover v-model:open="isOpen" mode="click">
        <UTooltip :text="t('toolbar.appMenu')" :delay-duration="1200">
            <UButton
                icon="i-lucide-menu"
                variant="ghost"
                color="neutral"
                class="toolbar-icon-button"
                :aria-label="t('toolbar.appMenu')"
            />
        </UTooltip>

        <template #content>
            <div class="app-menu">
                <div class="app-menu-section-header">{{ t('menu.file') }}</div>
                <div class="app-menu-section">
                    <button
                        class="app-menu-item"
                        @click="emit('open-file'); close()"
                    >
                        <UIcon name="i-lucide-folder-open" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.openFile') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.openFile }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || !canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                        @click="emit('save'); close()"
                    >
                        <UIcon name="i-lucide-save" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.save') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.save }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isAnySaving || isHistoryBusy || isDjvuMode"
                        @click="emit('save-as'); close()"
                    >
                        <UIcon name="i-lucide-save-all" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.saveAs') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.saveAs }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isPreparingPrint"
                        @click="emit('print'); close()"
                    >
                        <UIcon
                            :name="isPreparingPrint ? 'i-lucide-loader-circle' : 'i-lucide-printer'"
                            :class="['app-menu-icon', { 'animate-spin': isPreparingPrint }]"
                        />
                        <span class="app-menu-label">{{ t('menu.print') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.print }}</span>
                    </button>
                    <div class="app-menu-divider" />
                    <button
                        class="app-menu-item"
                        @click="emit('combine-images'); close()"
                    >
                        <UIcon name="i-lucide-copy-plus" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.combineFiles') }}</span>
                    </button>
                    <div class="app-menu-divider" />
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || !canExportDocx || isExportingDocx"
                        @click="emit('export-docx'); close()"
                    >
                        <UIcon name="i-lucide-file-text" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.exportDocx') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.exportDocx }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf"
                        @click="emit('export-images'); close()"
                    >
                        <UIcon name="i-lucide-image" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.exportImages') }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf"
                        @click="emit('export-multi-page-tiff'); close()"
                    >
                        <UIcon name="i-lucide-images" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.exportMultiPageTiff') }}</span>
                    </button>
                    <template v-if="canUseDjvu && isDjvuMode">
                        <div class="app-menu-divider" />
                        <button
                            class="app-menu-item"
                            @click="emit('convert-to-pdf'); close()"
                        >
                            <UIcon name="i-lucide-refresh-cw" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.convertToPdf') }}</span>
                        </button>
                    </template>
                </div>

                <div class="app-menu-divider" />

                <div class="app-menu-section-header">{{ t('menu.actions') }}</div>
                <div class="app-menu-section">
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                        @click="emit('undo'); close()"
                    >
                        <UIcon name="i-lucide-undo-2" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.undo') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.undo }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                        @click="emit('redo'); close()"
                    >
                        <UIcon name="i-lucide-redo-2" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.redo') }}</span>
                        <span class="app-menu-shortcut">{{ shortcutLabels.redo }}</span>
                    </button>
                    <div class="app-menu-divider" />
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('insert-image-from-file'); close()"
                    >
                        <UIcon name="i-lucide-image-plus" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.insertImageFromFile') }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('paste-image-from-clipboard'); close()"
                    >
                        <UIcon name="i-lucide-clipboard-paste" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.pasteImageFromClipboard') }}</span>
                    </button>
                </div>

                <div class="app-menu-divider" />

                <div class="app-menu-section-header">{{ t('menu.pages') }}</div>
                <div class="app-menu-section">
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('delete-pages'); close()"
                    >
                        <UIcon name="i-lucide-trash-2" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.deleteSelectedPages') }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('extract-pages'); close()"
                    >
                        <UIcon name="i-lucide-file-output" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.extractSelectedPages') }}</span>
                    </button>
                    <div class="app-menu-divider" />
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('rotate-cw'); close()"
                    >
                        <UIcon name="i-lucide-rotate-cw" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.rotateClockwise') }}</span>
                    </button>
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('rotate-ccw'); close()"
                    >
                        <UIcon name="i-lucide-rotate-ccw" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.rotateCounterclockwise') }}</span>
                    </button>
                    <div class="app-menu-divider" />
                    <button
                        class="app-menu-item"
                        :disabled="!hasPdf || isDjvuMode"
                        @click="emit('insert-pages'); close()"
                    >
                        <UIcon name="i-lucide-file-plus" class="app-menu-icon" />
                        <span class="app-menu-label">{{ t('menu.insertPages') }}</span>
                    </button>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import { getShortcutLabels } from '@app/constants/shortcuts';

const { t } = useTypedI18n();

interface IProps {
    open: boolean
    hasPdf: boolean
    canSave: boolean
    canUndo: boolean
    canRedo: boolean
    canExportDocx: boolean
    isAnySaving: boolean
    isHistoryBusy: boolean
    isExportingDocx: boolean
    isPreparingPrint: boolean
    isDjvuMode: boolean
    canUseDjvu: boolean
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'open-file'): void
    (e: 'save'): void
    (e: 'save-as'): void
    (e: 'print'): void
    (e: 'combine-images'): void
    (e: 'export-docx'): void
    (e: 'export-images'): void
    (e: 'export-multi-page-tiff'): void
    (e: 'convert-to-pdf'): void
    (e: 'undo'): void
    (e: 'redo'): void
    (e: 'insert-image-from-file'): void
    (e: 'paste-image-from-clipboard'): void
    (e: 'delete-pages'): void
    (e: 'extract-pages'): void
    (e: 'rotate-cw'): void
    (e: 'rotate-ccw'): void
    (e: 'insert-pages'): void
}>();

const shortcutLabels = getShortcutLabels();

const isOpen = computed({
    get: () => props.open,
    set: (value: boolean) => emit('update:open', value),
});

function close() {
    isOpen.value = false;
}
</script>

<style scoped>
.app-menu {
    padding: 0.25rem;
    min-width: 15rem;
}

.app-menu-section {
    display: flex;
    flex-direction: column;
}

.app-menu-section-header {
    padding: 0.5rem 0.75rem 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ui-text-muted);
}

.app-menu-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.app-menu-item {
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

.app-menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.app-menu-item:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.app-menu-icon {
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    color: var(--ui-text-muted);
}

.app-menu-label {
    flex: 1;
}

.app-menu-shortcut {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    flex-shrink: 0;
    margin-left: 1rem;
}
</style>
