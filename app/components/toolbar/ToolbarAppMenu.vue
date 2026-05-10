<template>
    <nav v-if="isBrowserRuntime" class="app-menu-bar" :aria-label="t('toolbar.appMenu')">
        <UPopover
            v-model:open="menuOpen"
            mode="click"
            :content="menuContentOptions"
        >
            <button
                type="button"
                :class="['app-menu-trigger', { 'is-open': menuOpen }]"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
            >
                <span>{{ t('toolbar.appMenu') }}</span>
                <UIcon name="i-lucide-chevron-down" class="app-menu-trigger-chevron" />
            </button>

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
                            :disabled="!hasInteractiveDocument || !canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                            @click="emit('save'); close()"
                        >
                            <UIcon name="i-lucide-save" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.save') }}</span>
                            <span class="app-menu-shortcut">{{ shortcutLabels.save }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || isAnySaving || isHistoryBusy || isDjvuMode"
                            @click="emit('save-as'); close()"
                        >
                            <UIcon name="i-lucide-save-all" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.saveAs') }}</span>
                            <span class="app-menu-shortcut">{{ shortcutLabels.saveAs }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint"
                            @click="emit('print'); close()"
                        >
                            <UIcon
                                :name="isPreparingPrint && !isPreparingCurrentPagePrint ? 'i-lucide-loader-circle' : 'i-lucide-printer'"
                                :class="['app-menu-icon', { 'animate-spin': isPreparingPrint && !isPreparingCurrentPagePrint }]"
                            />
                            <span class="app-menu-label">{{ t('menu.print') }}</span>
                            <span class="app-menu-shortcut">{{ shortcutLabels.print }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint || isDjvuMode"
                            @click="emit('print-current-page'); close()"
                        >
                            <UIcon
                                v-if="isPreparingCurrentPagePrint"
                                name="i-lucide-loader-circle"
                                class="app-menu-icon animate-spin"
                            />
                            <PrintCurrentPageIcon v-else class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.printCurrentPage') }}</span>
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
                            :disabled="!hasInteractiveDocument || !canExportDocx || isExportingDocx"
                            @click="emit('export-docx'); close()"
                        >
                            <UIcon name="i-lucide-file-text" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.exportDocx') }}</span>
                            <span class="app-menu-shortcut">{{ shortcutLabels.exportDocx }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('export-images'); close()"
                        >
                            <UIcon name="i-lucide-image" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.exportImages') }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument"
                            @click="emit('export-multi-page-tiff'); close()"
                        >
                            <UIcon name="i-lucide-images" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.exportMultiPageTiff') }}</span>
                        </button>
                        <template v-if="canUseDjvu && isDjvuMode">
                            <div class="app-menu-divider" />
                            <button
                                class="app-menu-item"
                                :disabled="documentBusy"
                                @click="emit('convert-to-pdf'); close()"
                            >
                                <UIcon name="i-lucide-refresh-cw" class="app-menu-icon" />
                                <span class="app-menu-label">{{ t('menu.convertToPdf') }}</span>
                            </button>
                        </template>
                    </div>

                    <div class="app-menu-divider" />
                    <div class="app-menu-section-header">{{ t('menu.edit') }}</div>
                    <div class="app-menu-section">
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                            @click="emit('undo'); close()"
                        >
                            <UIcon name="i-lucide-undo-2" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.undo') }}</span>
                            <span class="app-menu-shortcut">{{ shortcutLabels.undo }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                            @click="emit('redo'); close()"
                        >
                            <UIcon name="i-lucide-redo-2" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.redo') }}</span>
                            <span class="app-menu-shortcut">{{ shortcutLabels.redo }}</span>
                        </button>
                        <div class="app-menu-divider" />
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="emit('insert-image-from-file'); close()"
                        >
                            <UIcon name="i-lucide-image-plus" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.insertImageFromFile') }}</span>
                        </button>
                        <button
                            class="app-menu-item"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="emit('paste-image-from-clipboard'); close()"
                        >
                            <UIcon name="i-lucide-clipboard-paste" class="app-menu-icon" />
                            <span class="app-menu-label">{{ t('menu.pasteImageFromClipboard') }}</span>
                        </button>
                    </div>
                </div>
            </template>
        </UPopover>
    </nav>
</template>

<script setup lang="ts">
import { getShortcutLabels } from '@app/constants/shortcuts';
import PrintCurrentPageIcon from '@app/components/icons/PrintCurrentPageIcon.vue';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';

const { t } = useTypedI18n();
const { isBrowserRuntime } = useRuntimeEnvironment();

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
    isPreparingCurrentPagePrint?: boolean
    isDjvuMode: boolean
    canUseDjvu: boolean
    documentBusy?: boolean
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'open-file'): void
    (e: 'save'): void
    (e: 'save-as'): void
    (e: 'print'): void
    (e: 'print-current-page'): void
    (e: 'combine-images'): void
    (e: 'export-docx'): void
    (e: 'export-images'): void
    (e: 'export-multi-page-tiff'): void
    (e: 'convert-to-pdf'): void
    (e: 'undo'): void
    (e: 'redo'): void
    (e: 'insert-image-from-file'): void
    (e: 'paste-image-from-clipboard'): void
}>();

const shortcutLabels = getShortcutLabels();
const hasInteractiveDocument = computed(() => props.hasPdf && props.documentBusy !== true);
const menuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 8,
    collisionPadding: 8,
};

const menuOpen = computed({
    get: () => props.open,
    set: (open: boolean) => emit('update:open', open),
});

watch(() => props.open, (open) => {
    if (!open) {
        menuOpen.value = false;
    }
});

function close() {
    emit('update:open', false);
}
</script>

<style scoped>
.app-menu-bar {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    height: var(--toolbar-control-height, 2.25rem);
}

.app-menu {
    min-width: 15rem;
    padding: 0.3125rem;
    background: var(--app-toolbar-menu-popover-bg);
}

.app-menu-section-header {
    padding: 0.5rem 0.75rem 0.25rem;
    color: var(--ui-text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
}

.app-menu-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: var(--toolbar-control-height, 2.25rem);
    padding: 0 0.5rem 0 0.625rem;
    border: 1px solid transparent;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--app-toolbar-menu-trigger-fg);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}

.app-menu-trigger:hover,
.app-menu-trigger.is-open {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
    color: var(--ui-text);
}

.app-menu-trigger.is-open {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    box-shadow: var(--app-toolbar-control-active-shadow);
}

.app-menu-trigger:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    outline: none;
}

.app-menu-trigger-chevron {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
    color: var(--ui-text-muted);
    transition: transform 150ms ease;
}

.app-menu-trigger.is-open .app-menu-trigger-chevron {
    transform: rotate(180deg);
}

.app-menu-section {
    display: flex;
    flex-direction: column;
}

.app-menu-divider {
    height: 1px;
    margin: 0.25rem 0;
    background-color: var(--app-toolbar-separator);
}

.app-menu-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--ui-text);
    font-size: 0.875rem;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
}

.app-menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.app-menu-item:hover:not(:disabled) {
    background-color: var(--app-toolbar-menu-item-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
}

.app-menu-icon {
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    color: var(--ui-text-muted);
}

.app-menu-item:hover:not(:disabled) .app-menu-icon {
    color: var(--ui-text);
}

.app-menu-label {
    flex: 1;
}

.app-menu-shortcut {
    flex-shrink: 0;
    margin-left: 1rem;
    color: var(--ui-text-muted);
    font-size: 0.75rem;
}
</style>
