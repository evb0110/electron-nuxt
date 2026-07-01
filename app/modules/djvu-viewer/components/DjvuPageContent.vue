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
        aria-hidden="true"
    >
        <PdfPageSkeleton
            :padding="skeletonPadding"
            :content-height="skeletonContentHeight"
        />
    </div>
    <div
        v-if="showPageNumber"
        class="djvu-page-number"
    >
        {{ pageNumber }}
    </div>
</template>

<script setup lang="ts">
import { PdfPageSkeleton } from '@app/modules/pdf-viewer/public/component-exports/pdfPageSkeleton';
import type { IDjvuPageState } from '@app/modules/djvu-viewer/runtime/useDjvuPreviewRuntime';

const props = defineProps<{
    pageNumber: number;
    pageState: IDjvuPageState | undefined;
}>();

const emit = defineEmits<{ retry: [] }>();

const { t } = useTypedI18n();

const skeletonPadding = {
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
};
const skeletonContentHeight = 760;
const showPageNumber = computed(() => (
    Boolean(props.pageState?.objectUrl)
    || props.pageState?.status === 'error'
));
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

</style>
