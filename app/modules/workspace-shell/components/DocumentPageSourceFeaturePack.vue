<template>
    <div
        class="document-source-feature-pack"
        data-document-feature-pack="page-source"
        data-testid="document-page-source-viewer"
    >
        <div
            class="document-source-viewer__surface"
            :style="runtime.surfaceStyle"
        >
            <template
                v-for="pageNumber in runtime.mountedPages"
                :key="pageNumber"
            >
                <Teleport
                    v-if="runtime.getChassisOpeningShellTarget(pageNumber)"
                    :to="runtime.getChassisOpeningShellTarget(pageNumber)!"
                >
                    <DocumentPageSourcePageVisual
                        :content-height="runtime.pageLayouts[pageNumber - 1]?.height ?? 760"
                        :current-search-result-index="currentSearchResultIndex"
                        :document-load-generation="runtime.loadGeneration"
                        :error-message="runtime.getVisualError(pageNumber)"
                        host-owns-skeleton
                        :open-surface-generation="runtime.activeOpenSurfaceGeneration"
                        :page-number="pageNumber"
                        :render-generation="runtime.getRenderGeneration(pageNumber)"
                        :search-results="searchResults"
                        :surface="runtime.getSurface(pageNumber)"
                        :visual="runtime.getVisual(pageNumber)"
                        @surface-load="(surface, event) => runtime.handleSurfaceLoad(pageNumber, surface, event)"
                        @surface-error="(surface, event) => runtime.handleSurfaceError(pageNumber, surface, event)"
                    />
                </Teleport>
                <section
                    v-else
                    :ref="element => runtime.setPageElement(pageNumber, element)"
                    class="document-source-viewer__page"
                    :style="runtime.getPageStyle(pageNumber)"
                    :data-page-number="pageNumber"
                    :data-document-page-number="pageNumber"
                    :data-page-source-visual="runtime.getVisual(pageNumber)"
                    data-testid="document-page-source-page"
                >
                    <DocumentPageSourcePageVisual
                        :content-height="runtime.pageLayouts[pageNumber - 1]?.height ?? 760"
                        :current-search-result-index="currentSearchResultIndex"
                        :document-load-generation="runtime.loadGeneration"
                        :error-message="runtime.getVisualError(pageNumber)"
                        :open-surface-generation="runtime.activeOpenSurfaceGeneration"
                        :page-number="pageNumber"
                        :render-generation="runtime.getRenderGeneration(pageNumber)"
                        :search-results="searchResults"
                        :surface="runtime.getSurface(pageNumber)"
                        :visual="runtime.getVisual(pageNumber)"
                        @surface-load="(surface, event) => runtime.handleSurfaceLoad(pageNumber, surface, event)"
                        @surface-error="(surface, event) => runtime.handleSurfaceError(pageNumber, surface, event)"
                    />
                </section>
            </template>
        </div>
    </div>
</template>
<script setup lang="ts">
import DocumentPageSourcePageVisual from '@app/modules/workspace-shell/components/DocumentPageSourcePageVisual.vue';
import type {
    IDocumentPageSourceFeaturePackEmit,
    IDocumentPageSourceFeaturePackProps,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';
import { useDocumentPageSourceRuntime } from '@app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';

defineOptions({inheritAttrs: false});
const {
    src,
    zoom = 1,
    zoomMode = 'fit-width',
    viewMode = 'single',
    continuousScroll = true,
    documentRevisionToken = null,
    isActive = true,
    isResizing = false,
    currentPage = 1,
    searchResults = [],
    currentSearchResultIndex = -1,
} = defineProps<IDocumentPageSourceFeaturePackProps>();
const emit = defineEmits<IDocumentPageSourceFeaturePackEmit>();
const runtime = reactive(useDocumentPageSourceRuntime({
    emit,
    readProps: () => ({
        continuousScroll,
        currentPage,
        documentRevisionToken,
        isActive,
        isResizing,
        src,
        viewMode,
        zoom,
        zoomMode,
    }),
}));

defineExpose<IDocumentViewerExpose & {
    captureScrollSnapshot: () => unknown;
    restoreScrollSnapshot: (snapshot: unknown, options: {fallbackPage: number}) => void;
}>(runtime.viewerExpose);
</script>

<style scoped src="./DocumentPageSourceFeaturePack.css"></style>
