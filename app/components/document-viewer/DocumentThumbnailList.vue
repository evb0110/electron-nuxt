<template>
    <div
        ref="scrollRoot"
        class="document-thumbnail-list app-panel-scroll app-scrollbar"
        data-testid="document-thumbnail-list"
        @scroll.passive="handleScroll"
    >
        <div class="document-thumbnail-list__content" :style="{height: contentHeight}">
            <button
                v-for="item in virtualItems"
                :key="item.pageNumber"
                type="button"
                class="document-thumbnail-list__item"
                :class="{'is-current': item.pageNumber === currentPage}"
                :style="{height: `${String(item.height)}px`, transform: `translateY(${String(item.top)}px)`}"
                :aria-current="item.pageNumber === currentPage ? 'page' : undefined"
                :aria-label="t('documentSourceSidebar.goToPage', {page: item.pageNumber})"
                :data-thumbnail-page="item.pageNumber"
                :data-thumbnail-request-width="states.get(item.pageNumber)?.widthPx ?? ''"
                @click="emit('go-to-page', item.pageNumber)"
            >
                <span
                    class="document-thumbnail-list__frame"
                    :style="{aspectRatio: item.aspectRatio}"
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
                </span>
                <span class="document-thumbnail-list__label">{{ item.pageNumber }}</span>
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {ComponentPublicInstance} from 'vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import {useDocumentThumbnailController} from '@app/utils/document-viewer/thumbnails/useDocumentThumbnailController';

const props = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    isResizing?: boolean;
}>();
const emit = defineEmits<{'go-to-page': [pageNumber: number];}>();
const {t} = useTypedI18n();
const scrollRoot = ref<HTMLElement | null>(null);
const {
    contentHeight,
    handleScroll,
    states,
    virtualItems,
} = useDocumentThumbnailController({
    currentPage: toRef(props, 'currentPage'),
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
.document-thumbnail-list {
    height: 100%;
    min-height: 0;
    overflow: auto;
    padding: var(--app-sidebar-content-padding);
    background: var(--app-document-thumbnails-background, var(--ui-bg-muted));
}

.document-thumbnail-list__content {
    position: relative;
    width: 100%;
}

.document-thumbnail-list__item {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    box-sizing: border-box;
    width: 100%;
    flex-direction: column;
    gap: var(--app-space-xs);
    align-items: center;
    padding: var(--app-sidebar-row-padding-block);
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    contain: layout paint;
    will-change: transform;
}

.document-thumbnail-list__item.is-current { border-color: var(--ui-primary); }

.document-thumbnail-list__frame {
    display: grid;
    width: 100%;
    min-height: 0;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    background: white;
    box-shadow: var(--app-document-page-shadow, 0 1px 3px rgb(0 0 0 / 18%));
}

.document-thumbnail-list__frame img,
.document-thumbnail-list__canvas-host,
.document-thumbnail-list__canvas-host :deep(canvas) {
    display: block;
    width: 100%;
    height: 100%;
}

.document-thumbnail-list__frame img,
.document-thumbnail-list__canvas-host :deep(canvas) { object-fit: contain; }

.document-thumbnail-list__placeholder {
    width: 100%;
    height: 100%;
    background: var(--ui-bg-elevated);
    animation: document-thumbnail-pulse 1.2s ease-in-out infinite alternate;
}

.document-thumbnail-list__label {
    flex: 0 0 auto;
    font-size: var(--app-sidebar-caption-font-size);
}

@keyframes document-thumbnail-pulse {
    from { opacity: 0.52; }
    to { opacity: 0.86; }
}
</style>
