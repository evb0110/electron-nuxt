<template>
    <img
        v-if="pageState?.objectUrl"
        :src="pageState.objectUrl"
        :alt="t('djvu.pageAlt', { page: pageNumber })"
        class="h-full w-full select-none object-contain"
        decoding="async"
        draggable="false"
    >
    <div
        v-else-if="pageState?.status === 'error'"
        class="djvu-page-placeholder"
    >
        <UIcon
            name="i-ph-warning-circle"
            class="size-5 text-muted"
        />
        <span class="text-sm text-muted">
            {{ t('errors.djvu.open') }}
        </span>
        <UButton
            size="xs"
            variant="soft"
            color="neutral"
            :label="t('common.retry')"
            @click="emit('retry')"
        />
    </div>
    <div
        v-else
        class="djvu-page-skeleton"
        aria-hidden="true"
    >
        <div class="djvu-page-skeleton-content">
            <div class="djvu-page-skeleton-header">
                <USkeleton class="djvu-page-skeleton-title" />
                <USkeleton class="djvu-page-skeleton-subtitle" />
            </div>
            <div
                v-for="groupIndex in 5"
                :key="`djvu-page-skeleton-group-${pageNumber}-${groupIndex}`"
                class="djvu-page-skeleton-group"
            >
                <USkeleton class="djvu-page-skeleton-line" />
                <USkeleton class="djvu-page-skeleton-line" />
                <USkeleton class="djvu-page-skeleton-line djvu-page-skeleton-line--short" />
            </div>
        </div>
    </div>
    <div class="djvu-page-number">
        {{ pageNumber }}
    </div>
</template>

<script setup lang="ts">
import type { IDjvuPageState } from '@app/modules/djvu-viewer/runtime/useDjvuPreviewRuntime';

defineProps<{
    pageNumber: number;
    pageState: IDjvuPageState | undefined;
}>();

const emit = defineEmits<{ retry: [] }>();

const { t } = useTypedI18n();
</script>

<style scoped>
.djvu-page-placeholder {
    display: flex;
    height: 100%;
    width: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
}

.djvu-page-skeleton {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    background:
        linear-gradient(
            180deg,
            color-mix(in oklab, var(--ui-bg) 96%, var(--ui-bg-muted) 4%),
            color-mix(in oklab, var(--ui-bg) 90%, var(--ui-bg-muted) 10%)
        );
}

.djvu-page-skeleton-content {
    display: flex;
    height: 100%;
    width: 100%;
    flex-direction: column;
    gap: clamp(var(--app-space-10xl), 2%, var(--app-space-16xl));
    padding: clamp(var(--app-space-16xl), 8%, calc(var(--app-space-16xl) * 3));
    animation: djvu-page-skeleton-pulse 0.95s ease-in-out infinite;
}

.djvu-page-skeleton-header,
.djvu-page-skeleton-group {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-8xl);
}

.djvu-page-skeleton-title,
.djvu-page-skeleton-subtitle,
.djvu-page-skeleton-line {
    border-radius: var(--app-radius-full);
}

.djvu-page-skeleton-title {
    height: var(--app-space-16xl);
    width: 62%;
}

.djvu-page-skeleton-subtitle {
    height: var(--app-space-11xl);
    width: 44%;
    opacity: 0.78;
}

.djvu-page-skeleton-line {
    height: var(--app-space-12xl);
    width: 100%;
}

.djvu-page-skeleton-line--short {
    width: 78%;
}

.djvu-page-number {
    position: absolute;
    right: 0.75rem;
    bottom: 0.75rem;
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent);
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    backdrop-filter: blur(6px);
}

@keyframes djvu-page-skeleton-pulse {
    0%,
    100% {
        opacity: 0.5;
    }

    50% {
        opacity: 1;
    }
}

@media (prefers-reduced-motion: reduce) {
    .djvu-page-skeleton-content {
        animation: none;
    }
}
</style>
