<template>
    <div class="web-home">
        <section class="web-home__hero">
            <div class="web-home__hero-copy">
                <p class="web-home__eyebrow">
                    {{ t('webHome.eyebrow') }}
                </p>
                <h1 class="web-home__title">
                    {{ t('webHome.title') }}
                </h1>
                <p class="web-home__description">
                    {{ t('webHome.description') }}
                </p>
                <div class="web-home__actions">
                    <UButton
                        color="primary"
                        size="xl"
                        icon="i-lucide-folder-open"
                        :loading="isOpeningFile"
                        @click="handleOpenFile"
                    >
                        {{ t('webHome.primaryAction') }}
                    </UButton>
                    <UButton
                        color="neutral"
                        variant="soft"
                        size="xl"
                        icon="i-lucide-layout-grid"
                        :to="workspaceHref"
                    >
                        {{ t('webHome.secondaryAction') }}
                    </UButton>
                </div>
                <p class="web-home__caption">
                    {{ t('webHome.caption') }}
                </p>
            </div>

            <div class="web-home__hero-panel">
                <div class="web-home__stat-card">
                    <div class="web-home__stat-icon">
                        <UIcon name="i-lucide-search" class="size-5" />
                    </div>
                    <div>
                        <p class="web-home__stat-title">
                            {{ t('webHome.cards.searchTitle') }}
                        </p>
                        <p class="web-home__stat-copy">
                            {{ t('webHome.cards.searchDescription') }}
                        </p>
                    </div>
                </div>
                <div class="web-home__stat-card">
                    <div class="web-home__stat-icon">
                        <UIcon name="i-lucide-pen-tool" class="size-5" />
                    </div>
                    <div>
                        <p class="web-home__stat-title">
                            {{ t('webHome.cards.annotateTitle') }}
                        </p>
                        <p class="web-home__stat-copy">
                            {{ t('webHome.cards.annotateDescription') }}
                        </p>
                    </div>
                </div>
                <div class="web-home__stat-card">
                    <div class="web-home__stat-icon">
                        <UIcon name="i-lucide-save" class="size-5" />
                    </div>
                    <div>
                        <p class="web-home__stat-title">
                            {{ t('webHome.cards.saveTitle') }}
                        </p>
                        <p class="web-home__stat-copy">
                            {{ t('webHome.cards.saveDescription') }}
                        </p>
                    </div>
                </div>
            </div>
        </section>

        <UAlert
            v-if="openError"
            color="error"
            variant="soft"
            icon="i-lucide-circle-alert"
            class="web-home__alert"
            :title="t('webHome.errorTitle')"
            :description="openError"
        />

        <section class="web-home__content">
            <div class="web-home__recent">
                <div class="web-home__section-header">
                    <div>
                        <p class="web-home__section-eyebrow">
                            {{ t('webHome.recentEyebrow') }}
                        </p>
                        <h2 class="web-home__section-title">
                            {{ t('webHome.recentTitle') }}
                        </h2>
                    </div>
                    <UButton
                        v-if="recentFiles.length > 0"
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        icon="i-lucide-trash-2"
                        @click="handleClearRecent"
                    >
                        {{ t('emptyState.clearRecentFiles') }}
                    </UButton>
                </div>

                <div v-if="recentFiles.length === 0" class="web-home__empty-recent">
                    <UIcon name="i-lucide-file" class="size-6 text-[var(--ui-text-dimmed)]" />
                    <p class="web-home__empty-title">
                        {{ t('webHome.emptyRecentTitle') }}
                    </p>
                    <p class="web-home__empty-copy">
                        {{ t('webHome.emptyRecentDescription') }}
                    </p>
                </div>

                <ul v-else class="web-home__recent-list">
                    <li
                        v-for="file in recentFiles"
                        :key="file.originalPath"
                        class="web-home__recent-item"
                    >
                        <button
                            class="web-home__recent-open"
                            :aria-label="t('webHome.openRecent', { name: file.fileName })"
                            @click="handleOpenRecent(file.originalPath)"
                        >
                            <span class="web-home__recent-name">{{ file.fileName }}</span>
                            <span class="web-home__recent-meta">
                                {{ formatRelativeTimeLocalized(file.timestamp) }}
                            </span>
                        </button>
                        <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-lucide-x"
                            :aria-label="t('emptyState.removeFromRecent')"
                            @click="handleRemoveRecent(file)"
                        />
                    </li>
                </ul>
            </div>

            <div class="web-home__notes">
                <div class="web-home__section-header">
                    <div>
                        <p class="web-home__section-eyebrow">
                            {{ t('webHome.notesEyebrow') }}
                        </p>
                        <h2 class="web-home__section-title">
                            {{ t('webHome.notesTitle') }}
                        </h2>
                    </div>
                </div>

                <ul class="web-home__feature-list">
                    <li class="web-home__feature-item">
                        <UIcon name="i-lucide-check-circle" class="size-5 text-[var(--ui-primary)]" />
                        <span>{{ t('webHome.features.search') }}</span>
                    </li>
                    <li class="web-home__feature-item">
                        <UIcon name="i-lucide-check-circle" class="size-5 text-[var(--ui-primary)]" />
                        <span>{{ t('webHome.features.annotate') }}</span>
                    </li>
                    <li class="web-home__feature-item">
                        <UIcon name="i-lucide-check-circle" class="size-5 text-[var(--ui-primary)]" />
                        <span>{{ t('webHome.features.organize') }}</span>
                    </li>
                    <li class="web-home__feature-item">
                        <UIcon name="i-lucide-circle-alert" class="size-5 text-[var(--ui-text-dimmed)]" />
                        <span>{{ t('webHome.features.noOcr') }}</span>
                    </li>
                    <li class="web-home__feature-item">
                        <UIcon name="i-lucide-circle-alert" class="size-5 text-[var(--ui-text-dimmed)]" />
                        <span>{{ t('webHome.features.noDjvu') }}</span>
                    </li>
                </ul>
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/platform-api';
import type { IRecentFile } from '@contracts/shared';
import { formatRelativeTime } from '@app/utils/formatters';
import { getPlatformAPI } from '@app/utils/platform';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { useWorkspaceLaunchIntent } from '@app/composables/useWorkspaceLaunchIntent';

const { t } = useTypedI18n();
const workspaceHref = '/workspace';
const isOpeningFile = ref(false);
const openError = ref<string | null>(null);
const {
    recentFiles,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();
const {
    queueOpenPath,
    queueOpenResult,
} = useWorkspaceLaunchIntent();

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

async function navigateToWorkspace() {
    await navigateTo(workspaceHref);
}

async function handleOpenFile() {
    if (isOpeningFile.value) {
        return;
    }

    isOpeningFile.value = true;
    openError.value = null;
    try {
        const result = await getPlatformAPI().documents.openPdfDialog();
        if (!result) {
            return;
        }

        queueOpenResult(result);
        await navigateToWorkspace();
    } catch (error) {
        openError.value = error instanceof Error ? error.message : t('errors.file.open');
    } finally {
        isOpeningFile.value = false;
    }
}

async function handleOpenRecent(path: TDocumentRef) {
    openError.value = null;
    queueOpenPath(path);
    await navigateToWorkspace();
}

async function handleRemoveRecent(file: IRecentFile) {
    openError.value = null;
    try {
        await removeRecentFile(file);
    } catch (error) {
        openError.value = error instanceof Error ? error.message : t('errors.recent.remove');
    }
}

async function handleClearRecent() {
    openError.value = null;
    try {
        await clearRecentFiles();
    } catch (error) {
        openError.value = error instanceof Error ? error.message : t('errors.recent.clear');
    }
}

onMounted(() => {
    void loadRecentFiles();
});
</script>

<style scoped>
.web-home {
    min-height: 100vh;
    padding: clamp(1.25rem, 2.5vw, 2rem);
    background:
        radial-gradient(circle at top left, color-mix(in oklab, var(--ui-primary) 12%, transparent 88%), transparent 32%),
        linear-gradient(180deg, color-mix(in oklab, var(--ui-bg) 88%, var(--ui-bg-elevated) 12%), var(--app-window-bg));
}

.web-home__hero,
.web-home__content {
    width: min(100%, 1120px);
    margin: 0 auto;
}

.web-home__hero {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(18rem, 0.9fr);
    gap: clamp(1.5rem, 4vw, 3rem);
    align-items: stretch;
}

.web-home__hero-copy,
.web-home__hero-panel,
.web-home__recent,
.web-home__notes {
    border: 1px solid color-mix(in oklab, var(--ui-border) 84%, transparent 16%);
    border-radius: 1.5rem;
    background: color-mix(in oklab, var(--ui-bg) 90%, var(--ui-bg-elevated) 10%);
    box-shadow: var(--shadow-popup);
    backdrop-filter: blur(16px);
}

.web-home__hero-copy {
    padding: clamp(1.75rem, 3vw, 3rem);
}

.web-home__hero-panel {
    padding: clamp(1.25rem, 2.5vw, 1.75rem);
    display: flex;
    flex-direction: column;
    gap: 1rem;
}

.web-home__eyebrow,
.web-home__section-eyebrow {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ui-primary);
}

.web-home__title {
    margin: 0;
    font-size: clamp(2.4rem, 5vw, 4.4rem);
    line-height: 0.96;
    letter-spacing: -0.04em;
    color: var(--ui-text-highlighted);
}

.web-home__description,
.web-home__caption,
.web-home__stat-copy,
.web-home__empty-copy {
    color: var(--ui-text-muted);
}

.web-home__description {
    max-width: 36rem;
    margin: 1rem 0 0;
    font-size: 1.05rem;
    line-height: 1.65;
}

.web-home__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.875rem;
    margin-top: 1.75rem;
}

.web-home__caption {
    margin: 1rem 0 0;
    font-size: 0.875rem;
}

.web-home__stat-card {
    display: flex;
    gap: 0.875rem;
    align-items: flex-start;
    padding: 1rem;
    border-radius: 1rem;
    background: color-mix(in oklab, var(--ui-bg-elevated) 82%, transparent 18%);
    border: 1px solid color-mix(in oklab, var(--ui-border) 88%, transparent 12%);
}

.web-home__stat-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.4rem;
    height: 2.4rem;
    border-radius: 0.875rem;
    background: color-mix(in oklab, var(--ui-primary) 16%, var(--ui-bg) 84%);
    color: var(--ui-primary);
}

.web-home__stat-title,
.web-home__section-title,
.web-home__empty-title,
.web-home__recent-name {
    margin: 0;
    font-weight: 600;
    color: var(--ui-text-highlighted);
}

.web-home__stat-copy {
    margin: 0.25rem 0 0;
    font-size: 0.875rem;
    line-height: 1.5;
}

.web-home__alert,
.web-home__content {
    margin-top: 1.5rem;
}

.web-home__content {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr);
    gap: 1.5rem;
}

.web-home__recent,
.web-home__notes {
    padding: clamp(1.25rem, 2.5vw, 1.75rem);
}

.web-home__section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}

.web-home__section-title {
    font-size: 1.3rem;
}

.web-home__empty-recent {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 1.25rem 0.125rem 0;
}

.web-home__recent-list,
.web-home__feature-list {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
}

.web-home__recent-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.web-home__recent-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
    padding: 0.375rem;
    border-radius: 1rem;
    background: color-mix(in oklab, var(--ui-bg-elevated) 72%, transparent 28%);
}

.web-home__recent-open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    min-width: 0;
    padding: 0.875rem 1rem;
    border: 0;
    border-radius: 0.875rem;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.18s ease;
}

.web-home__recent-open:hover {
    background: color-mix(in oklab, var(--ui-primary) 10%, transparent 90%);
}

.web-home__recent-name,
.web-home__recent-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
}

.web-home__recent-meta {
    font-size: 0.82rem;
    color: var(--ui-text-dimmed);
}

.web-home__feature-list {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
}

.web-home__feature-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--ui-text);
}

@media (width <= 900px) {
    .web-home__hero,
    .web-home__content {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
