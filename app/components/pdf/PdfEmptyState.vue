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
                    <p class="rail-section-title">{{ t('emptyState.start') }}</p>
                    <button
                        type="button"
                        class="rail-item is-active"
                        aria-current="page"
                    >
                        <UIcon name="i-lucide-clock-3" class="rail-item-icon" />
                        <span>{{ t('emptyState.recentFiles') }}</span>
                    </button>
                </nav>

                <nav class="rail-section" :aria-label="t('emptyState.sources')">
                    <p class="rail-section-title">{{ t('emptyState.sources') }}</p>
                    <button
                        type="button"
                        class="rail-item"
                        :disabled="openInProgress"
                        @click="emit('open-file')"
                    >
                        <UIcon name="i-lucide-folder-open" class="rail-item-icon" />
                        <span>{{ t('emptyState.openFile') }}</span>
                    </button>
                    <button
                        v-if="!isBrowserRuntime"
                        type="button"
                        class="rail-item"
                        :disabled="openInProgress"
                        @click="emit('open-folder')"
                    >
                        <UIcon name="i-lucide-folder" class="rail-item-icon" />
                        <span>{{ t('emptyState.openFolder') }}</span>
                    </button>
                </nav>
            </aside>

            <main class="start-main">
                <div class="start-dropzone" role="presentation">
                    <span class="dropzone-art" aria-hidden="true">
                        <FileTypeIcon kind="document" class="dropzone-art-icon" />
                    </span>
                    <span class="dropzone-copy">
                        <strong>{{ t('emptyState.dropTitle') }}</strong>
                        <span>{{ t('emptyState.dropSubtitle') }}</span>
                    </span>
                    <span class="dropzone-divider">{{ t('emptyState.or') }}</span>
                    <button
                        type="button"
                        class="dropzone-cta"
                        :aria-label="t('toolbar.openPdf')"
                        :disabled="openInProgress"
                        @click="emit('open-file')"
                    >
                        <UIcon name="i-lucide-folder-open" class="dropzone-cta-icon" />
                        <span>{{ t('emptyState.openFileEllipsis') }}</span>
                    </button>
                </div>

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
                            <UTooltip :text="t('emptyState.clearRecentFiles')" :delay-duration="1200">
                                <button
                                    type="button"
                                    class="recent-clear"
                                    :disabled="recentFiles.length === 0"
                                    :aria-label="t('emptyState.clearRecentFiles')"
                                    @click="emit('clear-recent')"
                                >
                                    <UIcon name="i-lucide-trash-2" />
                                    <span>{{ t('emptyState.clearHistory') }}</span>
                                </button>
                            </UTooltip>
                        </div>
                    </header>

                    <div v-if="visibleRecentFiles.length > 0" class="recent-table" role="table">
                        <div class="recent-row recent-row--head" role="row">
                            <span role="columnheader" class="recent-col recent-col--name">{{ t('emptyState.columnName') }}</span>
                            <span role="columnheader" class="recent-col recent-col--location">{{ t('emptyState.columnLocation') }}</span>
                            <span role="columnheader" class="recent-col recent-col--time">{{ t('emptyState.columnOpened') }}</span>
                            <span class="recent-col recent-col--remove" aria-hidden="true" />
                        </div>
                        <button
                            v-for="file in visibleRecentFiles"
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
                            <span class="recent-col recent-col--remove" role="cell">
                                <UTooltip :text="t('emptyState.removeFromRecent')" :delay-duration="1200">
                                    <span
                                        class="recent-remove"
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
                        <button
                            v-if="filteredRecentFiles.length > MAX_VISIBLE_RECENT_FILES"
                            type="button"
                            class="recent-show-more"
                            @click="showAll = !showAll"
                        >
                            <span>{{ showAll ? t('emptyState.showLess') : t('emptyState.showMore') }}</span>
                            <UIcon
                                :name="showAll ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                                class="recent-show-more-icon"
                            />
                        </button>
                    </footer>
                </section>
            </main>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/platform-api';
import { formatRelativeTime } from '@app/utils/formatters';
import {
    displayProcessedCount,
    formatEtaDuration,
} from '@app/utils/progress-formatting';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { isBrowserDocumentRef } from '@app/utils/document-ref';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';

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
} = defineProps<{
    recentFiles: IRecentFile[];
    recentFilesResolved?: boolean;
    openBatchProgress?: IOpenBatchProgress | null;
    openInProgress?: boolean;
}>();

const emit = defineEmits<{
    'open-file': [];
    'open-folder': [];
    'open-recent': [file: IRecentFile];
    'remove-recent': [file: IRecentFile];
    'clear-recent': [];
}>();

const { t } = useTypedI18n();
const { isBrowserRuntime } = useRuntimeEnvironment();
const MAX_VISIBLE_RECENT_FILES = 6;
const recentFilesHeadingId = useId();
const recentSearch = ref('');
const showAll = ref(false);

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
const visibleRecentFiles = computed(() => (
    showAll.value
        ? filteredRecentFiles.value
        : filteredRecentFiles.value.slice(0, MAX_VISIBLE_RECENT_FILES)
));
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
    });
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

.rail-section-title {
    margin: 0 0 0.3rem;
    padding: 0 0.55rem;
    color: var(--app-start-rail-section-fg);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
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
    opacity: 0.5;
    cursor: default;
}

.rail-item-icon {
    width: 1.05rem;
    height: 1.05rem;
    flex: 0 0 auto;
    color: currentcolor;
    opacity: 0.85;
}

.start-main {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    min-width: 0;
    height: 100%;
    min-height: 0;
}

.start-dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.85rem;
    width: 100%;
    min-height: 17rem;
    padding: 2.5rem 2.25rem;
    border: 1.5px dashed var(--app-start-dropzone-border);
    border-radius: 0.9rem;
    background: var(--app-start-dropzone-bg);
    color: var(--ui-text);
    text-align: center;
    flex: 0 0 auto;
}

.dropzone-art {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 3.4rem;
    height: 3.85rem;
    flex: 0 0 auto;
    filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--ui-bg-inverted) 10%, transparent));
}

.dropzone-art-icon {
    width: 100%;
    height: 100%;
}

.dropzone-copy {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    min-width: 0;
}

.dropzone-copy strong {
    color: var(--ui-text-highlighted);
    font-size: 1.05rem;
    font-weight: 650;
    line-height: 1.3;
}

.dropzone-copy span {
    color: var(--ui-text-muted);
    font-size: 0.85rem;
}

.dropzone-divider {
    color: var(--ui-text-dimmed);
    font-size: 0.83rem;
    margin: 0.15rem 0;
    flex: 0 0 auto;
}

.dropzone-cta {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 13rem;
    height: 2.65rem;
    padding: 0 1.25rem;
    border: 0;
    border-radius: 0.55rem;
    justify-content: center;
    background: linear-gradient(180deg, var(--app-start-primary-grad-from) 0%, var(--app-start-primary-grad-to) 100%);
    color: var(--app-start-primary-fg);
    font-size: 0.83rem;
    font-weight: 600;
    box-shadow: var(--app-start-primary-shadow);
    cursor: pointer;
    flex: 0 0 auto;
    transition: filter 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
}

.dropzone-cta:hover:not(:disabled) {
    filter: brightness(1.06);
}

.dropzone-cta:active:not(:disabled) {
    transform: translateY(1px);
}

.dropzone-cta:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 2px;
}

.dropzone-cta:disabled {
    cursor: not-allowed;
    opacity: 0.6;
}

.dropzone-cta-icon {
    width: 0.95rem;
    height: 0.95rem;
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
    grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr) auto 3.25rem;
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
    padding: 0.55rem 0 0.55rem 1.05rem;
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
    color: var(--ui-text-dimmed);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    box-shadow: inset 0 -1px 0 var(--app-start-row-divider);
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
    gap: 0.7rem;
    min-width: 0;
}

.recent-col--location {
    color: var(--ui-text-muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-col--time {
    color: var(--ui-text-dimmed);
    font-size: 0.78rem;
    white-space: nowrap;
    text-align: right;
}

.recent-col--remove {
    display: flex;
    justify-content: center;
    padding-right: 0.55rem;
}

.recent-file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.9rem;
    flex: 0 0 auto;
}

.recent-file-name {
    color: var(--ui-text);
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    color: var(--app-start-row-remove-fg);
    background: transparent;
    opacity: 0;
    cursor: pointer;
    transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
}

.recent-remove :deep(.iconify) {
    width: 1rem;
    height: 1rem;
}

.recent-row--data:hover .recent-remove,
.recent-row--data:focus-within .recent-remove {
    opacity: 1;
}

.recent-remove:hover {
    background: var(--app-start-row-remove-hover-bg);
    color: var(--app-start-row-remove-hover-fg);
}

.recent-remove:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: 1px;
    opacity: 1;
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
    margin-top: auto;
    padding: 0.6rem 1.05rem;
    border-top: 1px solid var(--app-start-row-divider);
    background: color-mix(in oklab, var(--ui-bg) 96%, var(--ui-bg-muted) 4%);
}

.recent-count {
    color: var(--ui-text-dimmed);
    font-size: 0.78rem;
}

.recent-show-more {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 0;
    background: transparent;
    color: var(--ui-text-muted);
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0.25rem 0.4rem;
    border-radius: 0.3rem;
    transition: background-color 0.12s ease, color 0.12s ease;
}

.recent-show-more:hover {
    background: var(--app-start-row-hover-bg);
    color: var(--ui-text);
}

.recent-show-more-icon {
    width: 0.85rem;
    height: 0.85rem;
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
    .start-dropzone {
        min-height: 11rem;
        padding: 1.5rem 1.25rem;
        gap: 0.6rem;
    }

    .dropzone-cta {
        width: 100%;
        justify-content: center;
    }

    .recent-table {
        grid-template-columns: minmax(0, 1fr) auto 2.5rem;
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