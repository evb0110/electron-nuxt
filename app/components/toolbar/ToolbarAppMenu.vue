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
                <UIcon name="i-ph-caret-down" class="app-menu-trigger-chevron" />
            </button>

            <template #content>
                <div class="app-menu toolbar-menu-panel">
                    <div class="app-menu-section-header toolbar-menu-section-header">{{ t('menu.file') }}</div>
                    <div class="app-menu-section toolbar-menu-section">
                        <button
                            class="app-menu-item toolbar-menu-item"
                            @click="handleMenuCommand('open-file')"
                        >
                            <UIcon name="i-ph-folder-open" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.openFile') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.openFile }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || !canSave || isAnySaving || isHistoryBusy || isDjvuMode"
                            @click="handleMenuCommand('save')"
                        >
                            <UIcon name="i-ph-floppy-disk" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.save') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.save }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isAnySaving || isHistoryBusy || isDjvuMode"
                            @click="handleMenuCommand('save-as')"
                        >
                            <UIcon name="i-ph-floppy-disk-back" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.saveAs') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.saveAs }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint"
                            @click="handleMenuCommand('print')"
                        >
                            <UIcon
                                :name="isPreparingPrint && !isPreparingCurrentPagePrint ? 'i-ph-circle-notch' : 'i-ph-printer'"
                                :class="['app-menu-icon', 'toolbar-menu-icon', { 'animate-spin': isPreparingPrint && !isPreparingCurrentPagePrint }]"
                            />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.print') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.print }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isPreparingPrint || isDjvuMode"
                            @click="handleMenuCommand('print-current-page')"
                        >
                            <UIcon
                                v-if="isPreparingCurrentPagePrint"
                                name="i-ph-circle-notch"
                                class="app-menu-icon toolbar-menu-icon animate-spin"
                            />
                            <PrintCurrentPageIcon v-else class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.printCurrentPage') }}</span>
                        </button>
                        <div class="app-menu-divider toolbar-menu-divider" />
                        <button
                            class="app-menu-item toolbar-menu-item"
                            @click="handleMenuCommand('combine-images')"
                        >
                            <UIcon name="i-ph-stack-plus" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.combineFiles') }}</span>
                        </button>
                        <div class="app-menu-divider toolbar-menu-divider" />
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || !canExportDocx || isExportingDocx"
                            @click="handleMenuCommand('export-docx')"
                        >
                            <UIcon name="i-ph-file-text" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.exportDocx') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.exportDocx }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('export-images')"
                        >
                            <UIcon name="i-ph-image" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.exportImages') }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument"
                            @click="handleMenuCommand('export-multi-page-tiff')"
                        >
                            <UIcon name="i-ph-images" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.exportMultiPageTiff') }}</span>
                        </button>
                        <template v-if="canUseDjvu && isDjvuMode">
                            <div class="app-menu-divider toolbar-menu-divider" />
                            <button
                                class="app-menu-item toolbar-menu-item"
                                :disabled="documentBusy"
                                @click="handleMenuCommand('convert-to-pdf')"
                            >
                                <UIcon name="i-ph-arrows-clockwise" class="app-menu-icon toolbar-menu-icon" />
                                <span class="app-menu-label toolbar-menu-label">{{ t('menu.convertToPdf') }}</span>
                            </button>
                        </template>
                    </div>

                    <div class="app-menu-divider toolbar-menu-divider" />
                    <div class="app-menu-section-header toolbar-menu-section-header">{{ t('menu.edit') }}</div>
                    <div class="app-menu-section toolbar-menu-section">
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || !canUndo || isHistoryBusy || isAnySaving || isDjvuMode"
                            @click="handleMenuCommand('undo')"
                        >
                            <UIcon name="i-ph-arrow-u-up-left" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.undo') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.undo }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || !canRedo || isHistoryBusy || isAnySaving || isDjvuMode"
                            @click="handleMenuCommand('redo')"
                        >
                            <UIcon name="i-ph-arrow-u-up-right" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.redo') }}</span>
                            <span class="app-menu-shortcut toolbar-menu-shortcut">{{ shortcutLabels.redo }}</span>
                        </button>
                        <div class="app-menu-divider toolbar-menu-divider" />
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="handleMenuCommand('insert-image-from-file')"
                        >
                            <UIcon name="i-ph-image" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.insertImageFromFile') }}</span>
                        </button>
                        <button
                            class="app-menu-item toolbar-menu-item"
                            :disabled="!hasInteractiveDocument || isDjvuMode"
                            @click="handleMenuCommand('paste-image-from-clipboard')"
                        >
                            <UIcon name="i-ph-clipboard-text" class="app-menu-icon toolbar-menu-icon" />
                            <span class="app-menu-label toolbar-menu-label">{{ t('menu.pasteImageFromClipboard') }}</span>
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

const {
    documentBusy,
    hasPdf,
    open,
} = defineProps<IProps>();

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

type TMenuCommand =
    | 'open-file'
    | 'save'
    | 'save-as'
    | 'print'
    | 'print-current-page'
    | 'combine-images'
    | 'export-docx'
    | 'export-images'
    | 'export-multi-page-tiff'
    | 'convert-to-pdf'
    | 'undo'
    | 'redo'
    | 'insert-image-from-file'
    | 'paste-image-from-clipboard';

const emitMenuCommand = {
    'open-file': () => emit('open-file'),
    save: () => emit('save'),
    'save-as': () => emit('save-as'),
    print: () => emit('print'),
    'print-current-page': () => emit('print-current-page'),
    'combine-images': () => emit('combine-images'),
    'export-docx': () => emit('export-docx'),
    'export-images': () => emit('export-images'),
    'export-multi-page-tiff': () => emit('export-multi-page-tiff'),
    'convert-to-pdf': () => emit('convert-to-pdf'),
    undo: () => emit('undo'),
    redo: () => emit('redo'),
    'insert-image-from-file': () => emit('insert-image-from-file'),
    'paste-image-from-clipboard': () => emit('paste-image-from-clipboard'),
} satisfies Record<TMenuCommand, () => void>;

const shortcutLabels = getShortcutLabels();
const hasInteractiveDocument = computed(() => hasPdf && documentBusy !== true);
const menuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 8,
    collisionPadding: 8,
};

const menuOpen = computed({
    get: () => open,
    set: (open: boolean) => emit('update:open', open),
});

function close() {
    emit('update:open', false);
}

function handleMenuCommand(command: TMenuCommand) {
    emitMenuCommand[command]();
    close();
}
</script>

<style lang="scss" scoped>
@use '@app/assets/css/toolbarMenuShared';

.app-menu-bar {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    height: var(--toolbar-control-height, 2.25rem);
}

.app-menu {
    min-width: 15rem;
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
}

.app-menu-trigger.is-open:hover {
    background: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
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

</style>
