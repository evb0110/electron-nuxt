<template>
    <div
        v-if="selectedCount > 0"
        class="page-selection-bar"
    >
        <span class="page-selection-bar-label">
            {{ t('pageOps.pagesSelected', selectedCount) }}
        </span>

        <div class="page-selection-bar-actions">
            <AppTooltip :text="t('pageOps.rotateCcw')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :aria-label="t('pageOps.rotateCcw')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onRotateCcw"
                >
                    <UIcon name="i-ph-arrow-counter-clockwise" class="page-selection-bar-icon" />
                </button>
            </AppTooltip>

            <AppTooltip :text="t('pageOps.rotateCw')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :aria-label="t('pageOps.rotateCw')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onRotateCw"
                >
                    <UIcon name="i-ph-arrow-clockwise" class="page-selection-bar-icon" />
                </button>
            </AppTooltip>

            <AppTooltip :text="t('pageOps.extractPages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :aria-label="t('pageOps.extractPages')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onExtractPages"
                >
                    <UIcon name="i-ph-file-arrow-down" class="page-selection-bar-icon" />
                </button>
            </AppTooltip>

            <AppTooltip :text="t('pageOps.exportPages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :aria-label="t('pageOps.exportPages')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onExportPages"
                >
                    <UIcon name="i-ph-images" class="page-selection-bar-icon" />
                </button>
            </AppTooltip>

            <AppTooltip :text="t('pageOps.deletePages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button page-selection-bar-button-danger"
                    :aria-label="t('pageOps.deletePages')"
                    :disabled="isOperationInProgress || isDjvuMode"
                    @click="onDeletePages"
                >
                    <UIcon name="i-ph-trash" class="page-selection-bar-icon" />
                </button>
            </AppTooltip>
        </div>

        <button
            type="button"
            class="page-selection-bar-deselect"
            @click="onDeselect"
        >
            {{ t('pageOps.deselect') }}
        </button>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    selectedCount: number;
    isOperationInProgress: boolean;
    isDjvuMode?: boolean;
}>();

const emit = defineEmits<{
    'rotate-cw': [];
    'rotate-ccw': [];
    'extract-pages': [];
    'export-pages': [];
    'delete-pages': [];
    'deselect': [];
}>();

const { t } = useTypedI18n();

function onRotateCw() {
    emit('rotate-cw');
}

function onRotateCcw() {
    emit('rotate-ccw');
}

function onExtractPages() {
    emit('extract-pages');
}

function onExportPages() {
    emit('export-pages');
}

function onDeletePages() {
    emit('delete-pages');
}

function onDeselect() {
    emit('deselect');
}
</script>

<style scoped>
.page-selection-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-content-padding);
    border-bottom: 1px solid var(--app-sidebar-border);
    background: var(--app-pdf-page-selection-bar-bg);
    flex-shrink: 0;
}

.page-selection-bar-label {
    flex: 1 1 7rem;
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: var(--app-font-weight-semibold);
    color: var(--ui-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}

.page-selection-bar-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: var(--app-space-3xs);
    margin-left: auto;
}

.page-selection-bar-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--app-sidebar-action-size);
    height: var(--app-sidebar-action-size);
    border: 1px solid transparent;
    border-radius: var(--app-action-radius);
    background: transparent;
    color: var(--ui-text-muted);
    cursor: pointer;
    transition:
        background-color 0.12s ease,
        border-color 0.12s ease,
        color 0.12s ease;
}

.page-selection-bar-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.page-selection-bar-button:disabled {
    color: var(--ui-text-dimmed);
    cursor: default;
}

.page-selection-bar-button:disabled:hover {
    background: transparent;
    color: var(--ui-text-dimmed);
}

.page-selection-bar-button-danger:hover:not(:disabled) {
    color: var(--app-pdf-page-selection-danger-fg);
}

.page-selection-bar-icon {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
}

.page-selection-bar-deselect {
    display: inline-flex;
    align-items: center;
    min-height: var(--app-sidebar-action-size);
    padding: 0 var(--app-space-3xl);
    margin-left: auto;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-action-radius);
    background: var(--ui-bg);
    color: var(--ui-text);
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: var(--app-font-weight-medium);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition:
        background-color 0.12s ease,
        border-color 0.12s ease;
}

.page-selection-bar-deselect:hover {
    background: var(--ui-bg-muted);
    border-color: var(--app-control-active-hover-border);
}
</style>
