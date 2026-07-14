<template>
    <DocumentThumbnailRail
        :set-root="setScrollRoot"
        class="document-thumbnail-list"
        data-testid="document-thumbnail-list"
        @scroll.passive="handleScroll"
    >
        <div class="document-thumbnail-list__content" :style="{height: contentHeight}">
            <DocumentThumbnailItem
                v-for="item in virtualItems"
                :key="item.pageNumber"
                class="document-thumbnail-list__item"
                :current="item.pageNumber === currentPage"
                frame-class="document-thumbnail-list__frame"
                :frame-style="{aspectRatio: item.aspectRatio}"
                :style="{height: `${String(item.height)}px`, transform: `translateY(${String(item.top)}px)`}"
                :aria-label="t('documentSourceSidebar.goToPage', {page: item.pageNumber})"
                :data-thumbnail-page="item.pageNumber"
                :data-thumbnail-request-width="states.get(item.pageNumber)?.widthPx ?? ''"
                data-pane-relocation-scroll-item
                @click="emit('go-to-page', item.pageNumber)"
            >
                <img
                    v-if="typeof states.get(item.pageNumber)?.surface === 'string'"
                    :src="states.get(item.pageNumber)?.surface as string"
                    alt=""
                    draggable="false"
                >
                <span
                    v-else-if="states.get(item.pageNumber)?.surface"
                    :ref="element => setCanvasHost(item.pageNumber, element)"
                    class="document-thumbnail-list__canvas-host"
                />
                <span v-else class="document-thumbnail-list__placeholder" />
                <template #label>{{ item.pageNumber }}</template>
            </DocumentThumbnailItem>
        </div>
    </DocumentThumbnailRail>
</template>

<script setup lang="ts">
import type {ComponentPublicInstance} from 'vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import {useDocumentThumbnailController} from '@app/utils/document-viewer/thumbnails/useDocumentThumbnailController';
import DocumentThumbnailItem from '@app/components/document-viewer/DocumentThumbnailItem.vue';
import DocumentThumbnailRail from '@app/components/document-viewer/DocumentThumbnailRail.vue';

const props = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    isActive?: boolean;
    isResizing?: boolean;
}>();
const emit = defineEmits<{'go-to-page': [pageNumber: number];}>();
const {t} = useTypedI18n();
const scrollRoot = ref<HTMLElement | null>(null);
function setScrollRoot(element: HTMLElement | null) {
    scrollRoot.value = element;
}
const {
    contentHeight,
    handleScroll,
    states,
    virtualItems,
} = useDocumentThumbnailController({
    currentPage: toRef(props, 'currentPage'),
    isActive: computed(() => props.isActive ?? true),
    isResizing: computed(() => props.isResizing ?? false),
    scrollRoot,
    source: toRef(props, 'source'),
});

function setCanvasHost(
    pageNumber: number,
    value: Element | ComponentPublicInstance | null,
) {
    const host = value instanceof HTMLElement
        ? value
        : value && '$el' in value && value.$el instanceof HTMLElement ? value.$el : null;
    if (!host) {
        return;
    }
    const surface = states.get(pageNumber)?.surface;
    if (surface && typeof surface !== 'string' && host.firstChild !== surface) {
        host.replaceChildren(surface);
    }
}
</script>

<style scoped>
.document-thumbnail-list__content {
    position: relative;
    width: 100%;
}

.document-thumbnail-list__item {
    position: absolute;
    top: 0;
    left: 0;
    will-change: transform;
}

.document-thumbnail-list__placeholder {
    width: 100%;
    height: 100%;
    background: var(--ui-bg-elevated);
    animation: document-thumbnail-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes document-thumbnail-pulse {
    from { opacity: 0.52; }
    to { opacity: 0.86; }
}
</style>
