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
                    :disabled="isOperationInProgress"
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
                    :disabled="isOperationInProgress"
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
                    :disabled="isOperationInProgress"
                    @click="onExtractPages"
                >
                    <UIcon
                        name="i-ph-export"
                        class="page-selection-bar-icon page-selection-bar-icon-mirrored"
                    />
                </button>
            </AppTooltip>

            <AppTooltip :text="t('pageOps.exportPages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button"
                    :aria-label="t('pageOps.exportPages')"
                    :disabled="isOperationInProgress"
                    @click="onExportPages"
                >
                    <UIcon name="i-ph-export" class="page-selection-bar-icon" />
                </button>
            </AppTooltip>

            <AppTooltip :text="t('pageOps.deletePages')" :delay-duration="400">
                <button
                    type="button"
                    class="page-selection-bar-button page-selection-bar-button-danger"
                    :aria-label="t('pageOps.deletePages')"
                    :disabled="isOperationInProgress"
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
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--app-sidebar-border);
    background: var(--app-pdf-page-selection-bar-bg);
    flex-shrink: 0;
}

.page-selection-bar-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ui-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}

.page-selection-bar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
}

.page-selection-bar-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    border: 1px solid transparent;
    border-radius: 0.3125rem;
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
    width: 1rem;
    height: 1rem;
}

.page-selection-bar-icon-mirrored {
    transform: scaleX(-1);
}

.page-selection-bar-deselect {
    display: inline-flex;
    align-items: center;
    height: 1.625rem;
    padding: 0 0.5rem;
    margin-left: 0.25rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.3125rem;
    background: var(--ui-bg);
    color: var(--ui-text);
    font-size: 0.6875rem;
    font-weight: 500;
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
