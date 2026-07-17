<template>
    <div
        v-if="presentation.pendingFrame"
        class="document-source-viewer__pending-frame"
        data-document-page-visual="pending"
    />
    <div
        v-if="presentation.skeleton"
        class="document-source-viewer__skeleton"
        data-document-page-visual="skeleton"
        aria-hidden="true"
    >
        <DocumentPageSkeleton
            :padding="DOCUMENT_PAGE_SKELETON_PADDING"
            :content-height="contentHeight"
        />
    </div>
    <div
        v-if="presentation.error"
        class="document-source-viewer__error"
        data-document-page-visual="error"
        role="alert"
    >
        {{ errorMessage }}
    </div>
    <img
        v-if="surface"
        :key="surface"
        :src="surface"
        class="document-source-viewer__image"
        :class="{'document-page-visual--committed': presentation.fresh}"
        alt=""
        draggable="false"
        data-testid="document-page-source-image"
        :data-document-page-visual="presentation.fresh ? 'committed' : 'pending'"
        :data-page-render-generation="renderGeneration"
        :data-document-load-generation="documentLoadGeneration"
        :data-open-surface-generation="openSurfaceGeneration ?? ''"
        @load="emit('surfaceLoad', surface, $event)"
        @error="emit('surfaceError', surface)"
    >
    <DocumentPageSourceSearchLayer
        v-if="presentation.fresh"
        :page-number="pageNumber"
        :results="searchResults"
        :current-result-index="currentSearchResultIndex"
    />
</template>

<script setup lang="ts">
import type { IDocumentSearchMatch } from '@app/utils/document-viewer/search/documentSearch';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import DocumentPageSourceSearchLayer from '@app/modules/workspace-shell/components/DocumentPageSourceSearchLayer.vue';
import {
    DOCUMENT_PAGE_SKELETON_PADDING,
    resolveDocumentPageSourceVisualPresentation,
    type TDocumentPageSourceVisual,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';

const {
    contentHeight,
    currentSearchResultIndex,
    documentLoadGeneration,
    errorMessage,
    openSurfaceGeneration,
    pageNumber,
    renderGeneration,
    searchResults,
    surface,
    visual,
} = defineProps<{
    contentHeight: number;
    currentSearchResultIndex: number;
    documentLoadGeneration: number;
    errorMessage: string;
    openSurfaceGeneration: number | null;
    pageNumber: number;
    renderGeneration: number | '';
    searchResults: readonly IDocumentSearchMatch[];
    surface: string | null;
    visual: TDocumentPageSourceVisual;
}>();

const emit = defineEmits<{
    surfaceLoad: [surface: string, event: Event];
    surfaceError: [surface: string];
}>();

const presentation = computed(() => resolveDocumentPageSourceVisualPresentation(visual));
</script>

<style scoped>
.document-source-viewer__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    visibility: hidden;
}

.document-source-viewer__image.document-page-visual--committed {
    visibility: visible;
}

.document-source-viewer__pending-frame {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    background: var(--app-document-page-bg);
    border-radius: inherit;
}

.document-source-viewer__skeleton {
    position: absolute;
    inset: 0;
    background: var(--app-document-page-bg);
    box-shadow: none;
    border-radius: inherit;
}

.document-source-viewer__error {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--app-document-page-error-padding);
    color: var(--ui-error);
    text-align: center;
    background: var(--app-document-page-bg);
    border-radius: inherit;
}
</style>
