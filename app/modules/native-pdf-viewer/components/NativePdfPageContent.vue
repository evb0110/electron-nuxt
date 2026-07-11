<template>
    <div
        v-if="displayedObjectUrl"
        class="native-pdf-page-content"
    >
        <img
            :src="displayedObjectUrl"
            :alt="`PDF page ${pageNumber}`"
            class="native-pdf-page-image"
            decoding="async"
            draggable="false"
            @load="handleDisplayedImageLoad(displayedObjectUrl)"
        >
        <img
            v-if="pendingObjectUrl && pendingObjectUrl !== displayedObjectUrl"
            :src="pendingObjectUrl"
            :alt="`PDF page ${pageNumber}`"
            class="native-pdf-page-image native-pdf-page-image--pending"
            decoding="async"
            draggable="false"
            @load="handlePendingImageLoad(pendingObjectUrl)"
        >
    </div>
    <div
        v-else-if="pageState?.status === 'error'"
        class="native-pdf-page-placeholder"
    >
        <UIcon
            name="i-ph-warning-circle"
            class="size-5 text-muted"
        />
        <span class="text-sm text-muted">
            Unable to render this page
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
        class="native-pdf-page-number"
    >
        {{ pageNumber }}
    </div>
</template>

<script setup lang="ts">
import { PdfPageSkeleton } from '@app/modules/pdf-viewer/public/component-exports/pdfPageSkeleton';
import type { IDocumentPreviewPageState } from '@app/utils/document-viewer/pagePreviewSource';

const props = defineProps<{
    pageNumber: number;
    pageState: IDocumentPreviewPageState | undefined;
}>();

const emit = defineEmits<{
    retry: [];
    'visual-ready': [payload: {
        objectUrl: string;
        pageNumber: number;
    }];
}>();

const { t } = useTypedI18n();

const displayedObjectUrl = ref<string | null>(null);
const pendingObjectUrl = ref<string | null>(null);

const skeletonPadding = {
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
};
const skeletonContentHeight = 760;
const showPageNumber = computed(() => (
    Boolean(displayedObjectUrl.value)
    || props.pageState?.status === 'error'
));

function waitForPaintFrame() {
    if (typeof requestAnimationFrame !== 'function') {
        return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
        });
    });
}

async function emitVisualReadyAfterPaint(objectUrl: string) {
    await waitForPaintFrame();
    if (
        props.pageState?.objectUrl !== objectUrl
        || displayedObjectUrl.value !== objectUrl
    ) {
        return;
    }

    emit('visual-ready', {
        objectUrl,
        pageNumber: props.pageNumber,
    });
}

function handleDisplayedImageLoad(objectUrl: string | null) {
    if (!objectUrl) {
        return;
    }
    void emitVisualReadyAfterPaint(objectUrl);
}

async function handlePendingImageLoad(objectUrl: string | null) {
    if (!objectUrl) {
        return;
    }

    await waitForPaintFrame();
    if (
        pendingObjectUrl.value !== objectUrl
        || props.pageState?.objectUrl !== objectUrl
    ) {
        return;
    }

    displayedObjectUrl.value = objectUrl;
    pendingObjectUrl.value = null;
    emit('visual-ready', {
        objectUrl,
        pageNumber: props.pageNumber,
    });
}

watch(
    () => props.pageState?.objectUrl ?? null,
    (nextObjectUrl) => {
        if (!nextObjectUrl) {
            displayedObjectUrl.value = null;
            pendingObjectUrl.value = null;
            return;
        }

        if (!displayedObjectUrl.value) {
            displayedObjectUrl.value = nextObjectUrl;
            pendingObjectUrl.value = null;
            return;
        }

        if (displayedObjectUrl.value === nextObjectUrl) {
            pendingObjectUrl.value = null;
            return;
        }

        pendingObjectUrl.value = nextObjectUrl;
    },
    { immediate: true },
);
</script>

<style scoped>
.native-pdf-page-content {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--ui-bg);
}

.native-pdf-page-image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    user-select: none;
    object-fit: contain;
}

.native-pdf-page-image--pending {
    z-index: var(--app-z-pdf-native-pending-image);
}

.native-pdf-page-placeholder {
    display: flex;
    height: 100%;
    width: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-native-pdf-placeholder-gap);
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
}

.native-pdf-page-number {
    position: absolute;
    right: var(--app-native-pdf-page-number-offset);
    bottom: var(--app-native-pdf-page-number-offset);
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent);
    padding: var(--app-native-pdf-page-number-padding);
    font-size: var(--app-native-pdf-page-number-font-size);
    color: var(--ui-text-muted);
    backdrop-filter: blur(6px);
}

</style>
