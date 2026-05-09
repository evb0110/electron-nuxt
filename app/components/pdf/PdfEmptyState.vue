<template>
    <div class="empty-state">
        <div
            v-if="openBatchProgress"
            class="batch-progress"
            role="status"
            aria-live="polite"
        >
            <div class="flex items-center gap-2 text-sm text-[var(--ui-text)]">
                <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
                <span>{{ t('emptyState.preparingBatch') }}</span>
            </div>
            <p class="mt-2 text-xs text-[var(--ui-text-muted)]">
                {{ t('emptyState.preparingBatchProgress', {
                    processed: displayProcessedCount(openBatchProgress.processed, openBatchProgress.total),
                    total: openBatchProgress.total,
                }) }}
            </p>
            <UProgress :value="openBatchProgress.percent" class="mt-2" />
            <p v-if="batchEtaText" class="mt-2 text-xs text-[var(--ui-text-dimmed)]">
                {{ t('emptyState.preparingBatchEta', { eta: batchEtaText }) }}
            </p>
        </div>

        <div v-else-if="!recentFilesResolved" class="empty-state-loading">
            <UIcon
                name="i-lucide-loader-circle"
                class="size-7 animate-spin text-[var(--ui-text-dimmed)]"
            />
            <p class="text-sm text-[var(--ui-text-muted)]">{{ t('common.loading') }}</p>
        </div>

        <div v-else class="start-shell">
            <aside class="start-rail" :aria-label="t('emptyState.start')">
                <nav class="rail-section" :aria-label="t('emptyState.start')">
                    <button
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'recent' }"
                        :aria-current="activeSection === 'recent' ? 'page' : undefined"
                        @click="showRecentFiles"
                    >
                        <UIcon name="i-lucide-clock-3" class="rail-item-icon" />
                        <span>{{ t('emptyState.recentFiles') }}</span>
                        <span v-if="recentFiles.length > 0" class="rail-count">{{ recentFiles.length }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('menu.file')">
                    <button
                        v-if="canCombineFiles"
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'combine' }"
                        :aria-current="activeSection === 'combine' ? 'page' : undefined"
                        :disabled="openInProgress"
                        @click="showCombinePage"
                    >
                        <UIcon name="i-lucide-copy-plus" class="rail-item-icon" />
                        <span>{{ t('dialogs.combineFiles') }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('emptyState.workspace')">
                    <button
                        type="button"
                        class="rail-item"
                        :class="{ 'is-active': activeSection === 'settings' }"
                        :aria-current="activeSection === 'settings' ? 'page' : undefined"
                        @click="showSettingsPage"
                    >
                        <UIcon name="i-lucide-settings" class="rail-item-icon" />
                        <span>{{ t('toolbar.settings') }}</span>
                    </button>
                </nav>
            </aside>

            <main class="start-main">
                <template v-if="activeSection === 'recent'">
                    <section class="start-open-panel" :aria-labelledby="openPanelButtonId">
                        <span class="open-panel-art" aria-hidden="true">
                            <FileTypeIcon kind="document" class="open-panel-art-icon" />
                        </span>
                        <span class="open-panel-copy">
                            <span>{{ t('emptyState.openSubtitle') }}</span>
                        </span>
                        <UButton
                            :id="openPanelButtonId"
                            class="open-panel-cta"
                            color="primary"
                            icon="i-lucide-folder-open"
                            size="lg"
                            :label="t('emptyState.openFileEllipsis')"
                            :aria-label="t('toolbar.openPdf')"
                            :disabled="openInProgress"
                            @click="emit('open-file')"
                        />
                    </section>

                    <section class="start-recent" :aria-labelledby="recentFilesHeadingId">
                        <header class="recent-header">
                            <h3 :id="recentFilesHeadingId" class="recent-title">
                                {{ t('emptyState.recentFiles') }}
                            </h3>
                            <div class="recent-controls">
                                <label class="recent-search">
                                    <UIcon name="i-lucide-search" class="recent-search-icon" />
                                    <input
                                        v-model="recentSearch"
                                        type="search"
                                        :placeholder="t('emptyState.searchPlaceholder')"
                                        :aria-label="t('emptyState.searchRecentFiles')"
                                    >
                                </label>
                                <button
                                    type="button"
                                    class="recent-clear"
                                    :disabled="recentFiles.length === 0"
                                    :aria-label="t('emptyState.clearRecentFiles')"
                                    @click="requestClearRecent"
                                >
                                    <UIcon name="i-lucide-trash-2" />
                                    <span>{{ t('emptyState.clearHistory') }}</span>
                                </button>
                            </div>
                        </header>

                        <div v-if="filteredRecentFiles.length > 0" class="recent-table" role="table">
                            <div class="recent-row recent-row--head" role="row">
                                <span role="columnheader" class="recent-col recent-col--name">{{ t('emptyState.columnName') }}</span>
                                <span role="columnheader" class="recent-col recent-col--location">{{ t('emptyState.columnLocation') }}</span>
                                <span role="columnheader" class="recent-col recent-col--time">{{ t('emptyState.columnOpened') }}</span>
                                <span class="recent-col recent-col--actions" aria-hidden="true" />
                            </div>
                            <button
                                v-for="file in filteredRecentFiles"
                                :key="file.originalPath"
                                type="button"
                                class="recent-row recent-row--data"
                                role="row"
                                :class="{ 'is-disabled': openInProgress }"
                                :disabled="openInProgress"
                                @click="emit('open-recent', file)"
                            >
                                <span class="recent-col recent-col--name" role="cell">
                                    <span class="recent-file-icon" aria-hidden="true">
                                        <FileTypeIcon :kind="getFileKind(file)" />
                                    </span>
                                    <span class="recent-file-name">{{ file.fileName }}</span>
                                </span>
                                <span class="recent-col recent-col--location" role="cell">
                                    <template v-if="!isBrowserDocumentRef(file.originalPath)">
                                        {{ getParentFolder(file.originalPath) }}
                                    </template>
                                    <template v-else>{{ t('emptyState.locationBrowser') }}</template>
                                </span>
                                <span class="recent-col recent-col--time" role="cell">
                                    {{ formatRelativeTimeLocalized(file.timestamp) }}
                                </span>
                                <span class="recent-col recent-col--actions" role="cell">
                                    <UTooltip
                                        v-if="canRevealInFolder(file)"
                                        :text="t('status.showInFolder')"
                                        :delay-duration="1200"
                                    >
                                        <span
                                            class="recent-action recent-action--reveal"
                                            role="button"
                                            tabindex="0"
                                            :aria-label="t('status.showInFolder')"
                                            @click.stop="emit('reveal-recent', file)"
                                            @keydown.enter.stop="emit('reveal-recent', file)"
                                            @keydown.space.stop.prevent="emit('reveal-recent', file)"
                                        >
                                            <UIcon name="i-lucide-folder-open" />
                                        </span>
                                    </UTooltip>
                                    <UTooltip :text="t('emptyState.removeFromRecent')" :delay-duration="1200">
                                        <span
                                            class="recent-action recent-action--remove"
                                            role="button"
                                            tabindex="0"
                                            :aria-label="t('emptyState.removeFromRecent')"
                                            @click.stop="emit('remove-recent', file)"
                                            @keydown.enter.stop="emit('remove-recent', file)"
                                            @keydown.space.stop.prevent="emit('remove-recent', file)"
                                        >
                                            <UIcon name="i-lucide-x" />
                                        </span>
                                    </UTooltip>
                                </span>
                            </button>
                        </div>

                        <div v-else class="recent-empty">
                            <UIcon
                                :name="recentFiles.length === 0 ? 'i-lucide-folder-open' : 'i-lucide-search-x'"
                                class="recent-empty-icon"
                            />
                            <p>{{ recentFiles.length === 0 ? t('emptyState.noRecentFiles') : t('emptyState.noSearchResults') }}</p>
                        </div>

                        <footer v-if="filteredRecentFiles.length > 0" class="recent-footer">
                            <span class="recent-count">{{ recentItemsLabel }}</span>
                        </footer>
                    </section>
                </template>

                <CombinePdfPage
                    v-else-if="activeSection === 'combine'"
                    class="start-tool-page"
                    :show-back="false"
                    :show-eyebrow="false"
                    @close="showRecentFiles"
                    @open-result="handleCombineOpenResult"
                />
                <SettingsPage
                    v-else
                    class="start-tool-page"
                    :show-back="false"
                    :show-eyebrow="false"
                    @close="showRecentFiles"
                />
            </main>
        </div>

        <UModal
            :open="clearHistoryDialogOpen"
            :title="t('emptyState.clearHistoryConfirmTitle')"
            :ui="{ footer: 'justify-end' }"
            @update:open="clearHistoryDialogOpen = $event"
        >
            <template #description>
                <span class="sr-only">
                    {{ t('emptyState.clearHistoryConfirmDescription') }}
                </span>
            </template>

            <template #body>
                <div class="clear-history-confirm">
                    <span class="clear-history-confirm-icon" aria-hidden="true">
                        <UIcon name="i-lucide-triangle-alert" />
                    </span>
                    <p class="text-sm text-muted">
                        {{ t('emptyState.clearHistoryConfirmDescription') }}
                    </p>
                </div>
            </template>

            <template #footer="{ close }">
                <UButton
                    :label="t('common.cancel')"
                    color="neutral"
                    variant="outline"
                    @click="close"
                />
                <UButton
                    :label="t('emptyState.clearHistoryConfirmAction')"
                    color="error"
                    @click="confirmClearRecent"
                />
            </template>
        </UModal>
    </div>
</template>

<script setup lang="ts">
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import { formatRelativeTime } from '@app/utils/formatters';
import {
    displayProcessedCount,
    formatEtaDuration,
} from '@app/utils/progress-formatting';
import { isBrowserDocumentRef } from '@app/utils/document-ref';
import CombinePdfPage from '@app/components/combine/CombinePdfPage.vue';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import SettingsPage from '@app/components/settings/SettingsPage.vue';
import type { TStartSection } from '@app/types/start-page';

interface IRecentFile {
    originalPath: TDocumentRef;
    fileName: string;
    timestamp: number;
}

interface IOpenBatchProgress {
    processed: number;
    total: number;
    percent: number;
    estimatedRemainingMs: number | null;
}

const {
    recentFiles,
    recentFilesResolved = true,
    openBatchProgress = null,
    openInProgress = false,
    canCombineFiles = false,
    startSection = 'recent',
} = defineProps<{
    recentFiles: IRecentFile[];
    recentFilesResolved?: boolean;
    openBatchProgress?: IOpenBatchProgress | null;
    openInProgress?: boolean;
    canCombineFiles?: boolean;
    startSection?: TStartSection;
}>();

const emit = defineEmits<{
    'update:start-section': [section: TStartSection];
    'open-file': [];
    'open-recent': [file: IRecentFile];
    'remove-recent': [file: IRecentFile];
    'reveal-recent': [file: IRecentFile];
    'clear-recent': [];
    'open-settings': [];
    'combine-files': [];
    'open-combine-result': [result: TOpenFileResult];
}>();

const { t } = useTypedI18n();
const recentFilesHeadingId = useId();
const openPanelButtonId = useId();
const recentSearch = ref('');
const activeSection = ref<TStartSection>(startSection);
const clearHistoryDialogOpen = ref(false);
const relativeTimeNow = useState('empty-state-relative-time-now', () => Date.now());

const batchEtaText = computed(() => formatEtaDuration(openBatchProgress?.estimatedRemainingMs ?? null));
const filteredRecentFiles = computed(() => {
    const query = recentSearch.value.trim().toLocaleLowerCase();
    if (!query) {
        return recentFiles;
    }
    return recentFiles.filter((file) => {
        const haystack = `${file.fileName} ${String(file.originalPath)}`.toLocaleLowerCase();
        return haystack.includes(query);
    });
});
const recentItemsLabel = computed(() => t('emptyState.itemsCount', { count: filteredRecentFiles.value.length }));

function formatRelativeTimeLocalized(timestamp: number) {
    return formatRelativeTime(timestamp, {
        yesterday: t('relativeTime.yesterday'),
        daysAgo: (count: number) => t('relativeTime.daysAgo', { count }),
        oneHourAgo: t('relativeTime.oneHourAgo'),
        hoursAgo: (count: number) => t('relativeTime.hoursAgo', { count }),
        oneMinuteAgo: t('relativeTime.oneMinuteAgo'),
        minutesAgo: (count: number) => t('relativeTime.minutesAgo', { count }),
        justNow: t('relativeTime.justNow'),
    }, relativeTimeNow.value);
}

function getParentFolder(filePath: string) {
    const parts = filePath.split(/[\\/]/);
    parts.pop();
    const folderParts = parts.slice(-2);
    return folderParts.join('/');
}

function getFileExtension(file: IRecentFile) {
    const normalizedName = file.fileName.toLocaleLowerCase();
    return normalizedName.match(/\.([a-z0-9]+)$/u)?.[1] ?? '';
}

function canRevealInFolder(file: IRecentFile) {
    return !isBrowserDocumentRef(file.originalPath);
}

function getFileKind(file: IRecentFile) {
    const extension = getFileExtension(file);
    if (extension === 'pdf') {
        return 'pdf';
    }
    if (extension === 'djvu' || extension === 'djv') {
        return 'djvu';
    }
    if ([
        'png',
        'jpg',
        'jpeg',
        'webp',
        'tif',
        'tiff',
        'bmp',
    ].includes(extension)) {
        return 'image';
    }
    return 'document';
}

function showRecentFiles() {
    setActiveSection('recent');
}

function showCombinePage() {
    setActiveSection('combine');
}

function showSettingsPage() {
    setActiveSection('settings');
}

function handleCombineOpenResult(result: TOpenFileResult) {
    emit('open-combine-result', result);
}

function requestClearRecent() {
    if (recentFiles.length === 0) {
        return;
    }
    clearHistoryDialogOpen.value = true;
}

function confirmClearRecent() {
    clearHistoryDialogOpen.value = false;
    emit('clear-recent');
}

function setActiveSection(section: TStartSection) {
    activeSection.value = section;
    emit('update:start-section', section);
}

watch(() => startSection, (section) => {
    activeSection.value = section;
}, { immediate: true });

</script>

<style lang="scss" scoped>
.empty-state {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--app-start-bg);
    color: var(--ui-text);
    container-type: inline-size;
}

.empty-state-loading {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
}

.batch-progress {
    width: min(100%, 38rem);
    margin: 2rem auto;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg-elevated);
    padding: 0.75rem 1rem;
}

.clear-history-confirm {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
}

.clear-history-confirm-icon {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    background: var(--ui-error-50);
    color: var(--ui-error-600);
}

:global(.dark) .clear-history-confirm-icon {
    background: color-mix(in oklab, var(--ui-error) 18%, transparent);
    color: var(--ui-error-400);
}

.start-shell {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    gap: 1.5rem;
    width: 100%;
    max-width: 1280px;
    height: 100%;
    min-height: 0;
    margin: 0 auto;
    padding: 1.25rem clamp(0.75rem, 2vw, 1.5rem) 1.5rem;
}

.start-rail {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    padding: 0.5rem 0.25rem;
}

.rail-section {
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
}

.rail-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    height: 2rem;
    padding: 0 0.55rem;
    border: 0;
    border-radius: 0.45rem;
    background: transparent;
    color: var(--app-start-rail-item-fg);
    font-size: 0.83rem;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
}

.rail-item span:not(.rail-shortcut, .rail-count) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rail-item:hover:not(:disabled) {
    background: var(--app-start-rail-item-hover-bg);
    color: var(--app-start-rail-item-active-fg);
}

.rail-item.is-active {
    background: var(--app-start-rail-item-active-bg);
    color: var(--app-start-rail-item-active-fg);
    font-weight: 500;
}

.rail-item:disabled {
    opacity: 0.62;
    cursor: default;
}

.rail-item-icon {
    width: 1.05rem;
    height: 1.05rem;
    flex: 0 0 auto;
    color: currentcolor;
    opacity: 0.85;
}

.rail-shortcut {
    margin-left: auto;
    color: var(--ui-text-dimmed);
    font-size: 0.72rem;
    line-height: 1;
    white-space: nowrap;
}

.rail-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    margin-left: auto;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--app-start-rail-item-hover-bg);
    color: var(--ui-text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1;
}

.start-main {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    min-width: 0;
    height: 100%;
    min-height: 0;
}

.start-tool-page {
    height: 100%;
    min-height: 0;
}

.start-open-panel {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 1rem;
    width: 100%;
    padding: 0.85rem 1.05rem;
    border: 1px solid var(--app-start-card-border);
    border-radius: 0.65rem;
    background: var(--app-start-card-bg);
    color: var(--ui-text);
    flex: 0 0 auto;
}

.open-panel-art {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2.25rem;
    flex: 0 0 auto;
    filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--ui-bg-inverted) 10%, transparent));
}

.open-panel-art-icon {
    width: 100%;
    height: 100%;
}

.open-panel-copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
    min-width: 0;
    flex: 1 1 auto;
}

.open-panel-copy span {
    color: var(--ui-text-muted);
    font-size: 0.85rem;
}

.open-panel-cta {
    min-width: 13rem;
    flex: 0 0 auto;
    justify-content: center;
}

.start-recent {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--app-start-card-border);
    border-radius: 0.65rem;
    background: var(--app-start-card-bg);
    box-shadow: var(--app-start-card-shadow);
    overflow: hidden;
    flex: 1 1 0;
    min-height: 0;
}

.recent-header {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: space-between;
    padding: 0.85rem 1.05rem 0.75rem;
}

.recent-title {
    margin: 0;
    color: var(--ui-text);
    font-size: 0.93rem;
    font-weight: 600;
}

.recent-controls {
    display: flex;
    align-items: center;
    gap: 0.55rem;
}

.recent-search {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 16rem;
    height: 2rem;
    padding: 0 0.65rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.4rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.recent-search:focus-within {
    border-color: var(--app-toolbar-focus-ring);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--app-toolbar-focus-ring) 18%, transparent);
}

.recent-search-icon {
    width: 0.95rem;
    height: 0.95rem;
    flex: 0 0 auto;
}

.recent-search input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--ui-text);
    font-size: 0.8125rem;
}

.recent-search input::placeholder {
    color: var(--ui-text-dimmed);
}

.recent-clear {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 2rem;
    padding: 0 0.7rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.4rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.78rem;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.recent-clear :deep(.iconify) {
    width: 0.95rem;
    height: 0.95rem;
}

.recent-clear:hover:not(:disabled) {
    background: var(--app-start-row-hover-bg);
    color: var(--ui-text);
    border-color: color-mix(in oklab, var(--ui-border) 80%, var(--ui-text) 20%);
}

.recent-clear:disabled {
    opacity: 0.5;
    cursor: default;
}

.recent-table {
    display: grid;
    grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr) auto 5.5rem;
    grid-auto-rows: min-content;
    align-content: start;
    border-top: 1px solid var(--app-start-row-divider);
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.recent-row {
    display: grid;
    grid-template-columns: subgrid;
    grid-column: 1 / -1;
    column-gap: 1rem;
    align-items: center;
    width: 100%;
    padding: 0.7rem 0 0.7rem 1.05rem;
    border-bottom: 1px solid var(--app-start-row-divider);
    text-align: left;
    background: transparent;
    transition: background-color 0.1s ease;
}

.recent-row:last-child {
    border-bottom: 0;
}

.recent-row--head {
    position: sticky;
    top: 0;
    z-index: 1;
    padding-block: 0.45rem;
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
    box-shadow: inset 0 -1px 0 var(--app-start-row-divider);
}

.recent-row--head .recent-col {
    color: var(--ui-text-dimmed);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
}

.recent-row--data {
    border: 0;
    border-bottom: 1px solid var(--app-start-row-divider);
    cursor: pointer;
    color: var(--ui-text);
}

.recent-row--data:hover:not(.is-disabled, :disabled) {
    background: var(--app-start-row-hover-bg);
}

.recent-row--data.is-disabled {
    cursor: default;
    opacity: 0.6;
}

.recent-col {
    min-width: 0;
}

.recent-col--name {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    min-width: 0;
}

.recent-col--location {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-row--data .recent-col--location {
    color: var(--ui-text-muted);
    font-size: 0.8rem;
}

.recent-col--time {
    white-space: nowrap;
    text-align: right;
}

.recent-row--data .recent-col--time {
    color: var(--ui-text-dimmed);
    font-size: 0.78rem;
}

.recent-col--actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.45rem;
    padding-right: 0.7rem;
}

.recent-file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2.25rem;
    flex: 0 0 auto;
}

.recent-file-name {
    color: var(--ui-text);
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--ui-text-dimmed);
    opacity: 0;
    cursor: pointer;
    transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
}

.recent-action :deep(.iconify) {
    width: 1rem;
    height: 1rem;
}

.recent-row--data:hover .recent-action,
.recent-row--data:focus-within .recent-action {
    opacity: 1;
}

.recent-action:hover {
    background: var(--app-start-row-remove-hover-bg);
    color: var(--app-start-row-remove-hover-fg);
}

.recent-action:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 1px;
    opacity: 1;
}

.recent-action--remove {
    color: var(--app-start-row-remove-fg);
}

.recent-action--remove:hover {
    background: var(--app-start-row-remove-hover-bg);
    color: var(--app-start-row-remove-hover-fg);
}

.recent-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.65rem;
    flex: 1 1 auto;
    min-height: 14rem;
    border-top: 1px solid var(--app-start-row-divider);
    color: var(--ui-text-muted);
    text-align: center;
}

.recent-empty p {
    margin: 0;
    font-size: 0.88rem;
}

.recent-empty-icon {
    width: 2.25rem;
    height: 2.25rem;
    color: var(--ui-text-dimmed);
    opacity: 0.7;
}

.recent-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex: 0 0 auto;
    padding: 0.6rem 1.05rem;
    border-top: 1px solid var(--app-start-row-divider);
    background: color-mix(in oklab, var(--ui-bg) 96%, var(--ui-bg-muted) 4%);
}

.recent-count {
    color: var(--ui-text-dimmed);
    font-size: 0.78rem;
}

@container (max-width: 880px) {
    .start-shell {
        grid-template-columns: minmax(0, 1fr);
        gap: 0.75rem;
    }

    .start-rail {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 0.5rem 1rem;
        padding: 0.25rem 0;
    }

}

@container (max-width: 640px) {
    .start-open-panel {
        flex-direction: column;
        align-items: stretch;
        padding: 1rem 1.25rem;
        gap: 0.6rem;
        text-align: center;
    }

    .open-panel-art {
        align-self: center;
    }

    .open-panel-copy {
        align-items: center;
    }

    .open-panel-cta {
        width: 100%;
        justify-content: center;
    }

    .recent-table {
        grid-template-columns: minmax(0, 1fr) auto 5.25rem;
    }

    .recent-row {
        column-gap: 0.7rem;
    }

    .recent-col--location {
        display: none;
    }

    .recent-row--head .recent-col--location {
        display: none;
    }
}
</style>
