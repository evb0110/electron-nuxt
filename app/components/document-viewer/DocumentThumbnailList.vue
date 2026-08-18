<template>
    <DocumentThumbnailRail
        :set-root="setScrollRoot"
        class="document-thumbnail-list"
        data-testid="document-thumbnail-list"
        @scroll.passive="handleScroll"
        @wheel.passive="handleWheel"
        @pointerdown="handlePointerDown"
    >
        <div class="document-thumbnail-list__content" :style="{height: contentHeight}">
            <DocumentThumbnailItem
                v-for="item in virtualItems"
                :key="item.pageNumber"
                class="document-thumbnail-list__item"
                :current="item.pageNumber === currentPage"
                :aria-disabled="disabled || undefined"
                :selected="selectedPages?.has(item.pageNumber)"
                :tag="itemTag"
                :role="selectedPages ? 'option' : undefined"
                :aria-selected="selectedPages ? selectedPages.has(item.pageNumber) : undefined"
                :tabindex="itemTag === 'div'
                    ? (disabled ? -1 : item.pageNumber === currentPage ? 0 : -1)
                    : undefined"
                frame-class="document-thumbnail-list__frame"
                :frame-style="{aspectRatio: item.aspectRatio}"
                :style="{height: `${String(item.height)}px`, transform: `translateY(${String(item.top)}px)`}"
                :aria-label="t('documentSourceSidebar.goToPage', {page: item.pageNumber})"
                :data-thumbnail-page="item.pageNumber"
                :data-thumbnail-request-width="states.get(item.pageNumber)?.widthPx ?? ''"
                :disabled="disabled"
                data-pane-relocation-scroll-item
                @click="handleItemClick(item.pageNumber, $event)"
            >
                <template #overlay>
                    <slot name="overlay" :page-number="item.pageNumber" />
                </template>
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
                <template #label>
                    <slot name="label" :page-number="item.pageNumber">{{ item.pageNumber }}</slot>
                </template>
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
    itemMetricsKey?: unknown;
    itemTag?: 'button' | 'div';
    selectedPages?: ReadonlySet<number>;
    disabled?: boolean;
}>();
const emit = defineEmits<{'go-to-page': [pageNumber: number, event: MouseEvent];}>();
const {t} = useTypedI18n();
const scrollRoot = ref<HTMLElement | null>(null);
function setScrollRoot(element: HTMLElement | null) {
    scrollRoot.value = element;
}
const {
    contentHeight,
    handlePointerDown,
    handleScroll,
    handleWheel,
    states,
    virtualItems,
} = useDocumentThumbnailController({
    currentPage: toRef(props, 'currentPage'),
    isActive: computed(() => props.isActive ?? true),
    isResizing: computed(() => props.isResizing ?? false),
    itemMetricsKey: toRef(props, 'itemMetricsKey'),
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

function handleItemClick(pageNumber: number, event: MouseEvent) {
    if (props.disabled) {
        return;
    }
    emit('go-to-page', pageNumber, event);
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
    animation:
        document-thumbnail-pulse
        var(--app-animation-duration-skeleton)
        ease-in-out infinite alternate;
}

:global(html.app-low-graphics) .document-thumbnail-list__item {
    will-change: auto;
}

:global(html.app-low-graphics) .document-thumbnail-list__placeholder {
    animation: none;
}

@keyframes document-thumbnail-pulse {
    from { opacity: 0.52; }
    to { opacity: 0.86; }
}

@media (prefers-reduced-motion: reduce) {
    .document-thumbnail-list__item {
        will-change: auto;
    }

    .document-thumbnail-list__placeholder {
        animation: none;
    }
}
</style>
