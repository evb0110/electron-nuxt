<template>
    <template v-for="[pageNum, markers] in markersByPage" :key="`markers-${pageNum}`">
        <Teleport v-if="markerLayerTargets.get(pageNum)" :to="markerLayerTargets.get(pageNum)!">
            <PdfCommentMarkerLayer
                :page-number="pageNum"
                :markers="markers"
                @open-note="handleOpenNote"
                @context-menu="handleContextMenu"
                @move-marker="handleMoveMarker"
            />
        </Teleport>
    </template>
    <template v-for="(links, pageNum) in linksByPage" :key="`links-${pageNum}`">
        <Teleport v-if="linkLayerTargets.get(Number(pageNum))" :to="linkLayerTargets.get(Number(pageNum))!">
            <PdfLinkOverlayLayer :links="links" />
        </Teleport>
    </template>
</template>

<script setup lang="ts">
import PdfCommentMarkerLayer from '@app/components/pdf/annotations/PdfCommentMarkerLayer.vue';
import PdfLinkOverlayLayer from '@app/components/pdf/annotations/PdfLinkOverlayLayer.vue';
import { resolvePageTargets } from '@app/components/pdf/pdfViewerPortalTargets';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    ILinkAnnotation,
} from '@app/types/annotations';
import type { IMarkerViewModel } from '@app/composables/pdf/annotations/types';

interface IProps {
    viewerContainer: HTMLElement | null;
    markersByPage: Map<number, IMarkerViewModel[]>;
    linksByPage: Record<number, ILinkAnnotation[]>;
}

const {
    linksByPage,
    markersByPage,
    viewerContainer,
} = defineProps<IProps>();

const emit = defineEmits<{
    'open-note': [comment: IAnnotationCommentSummary];
    'context-menu': [comment: IAnnotationCommentSummary, event: MouseEvent];
    'move-marker': [comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect];
}>();

const portalTargetRefreshTick = ref(0);
let portalTargetObserver: MutationObserver | null = null;
let portalTargetRefreshFrame: number | null = null;

const markerLayerTargets = computed(() => {
    void portalTargetRefreshTick.value;
    return resolvePageTargets(viewerContainer, [...markersByPage.keys()]);
});

const linkLayerTargets = computed(() => {
    void portalTargetRefreshTick.value;
    return resolvePageTargets(viewerContainer, Object.keys(linksByPage).map(Number));
});

function handleOpenNote(comment: IAnnotationCommentSummary) {
    emit('open-note', comment);
}

function handleContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
    emit('context-menu', comment, event);
}

function handleMoveMarker(comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect) {
    emit('move-marker', comment, markerRect);
}

function refreshPortalTargets() {
    portalTargetRefreshTick.value += 1;
}

function cancelPortalTargetRefreshFrame() {
    if (portalTargetRefreshFrame === null || typeof window === 'undefined') {
        portalTargetRefreshFrame = null;
        return;
    }
    window.cancelAnimationFrame(portalTargetRefreshFrame);
    portalTargetRefreshFrame = null;
}

function schedulePortalTargetRefresh() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        refreshPortalTargets();
        return;
    }
    if (portalTargetRefreshFrame !== null) {
        return;
    }
    portalTargetRefreshFrame = window.requestAnimationFrame(() => {
        portalTargetRefreshFrame = null;
        refreshPortalTargets();
    });
}

function elementContainsPageContainer(element: Element) {
    return element.matches('.page_container')
        || Boolean(element.querySelector('.page_container'));
}

function mutationTouchesPortalTargets(records: MutationRecord[]) {
    return records.some((record) => {
        if (record.type === 'attributes') {
            return record.target instanceof Element
                && record.target.matches('.page_container');
        }

        return [
            ...record.addedNodes,
            ...record.removedNodes,
        ].some(node => node instanceof Element && elementContainsPageContainer(node));
    });
}

function reconnectPortalTargetObserver() {
    portalTargetObserver?.disconnect();
    portalTargetObserver = null;
    cancelPortalTargetRefreshFrame();

    if (!viewerContainer) {
        refreshPortalTargets();
        return;
    }

    refreshPortalTargets();
    if (typeof MutationObserver === 'undefined') {
        return;
    }

    portalTargetObserver = new MutationObserver((records) => {
        if (mutationTouchesPortalTargets(records)) {
            schedulePortalTargetRefresh();
        }
    });
    portalTargetObserver.observe(viewerContainer, {
        attributes: true,
        attributeFilter: [
            'class',
            'data-page',
        ],
        childList: true,
        subtree: true,
    });
}

onMounted(() => {
    reconnectPortalTargetObserver();
});

onBeforeUnmount(() => {
    portalTargetObserver?.disconnect();
    portalTargetObserver = null;
    cancelPortalTargetRefreshFrame();
});

watch(
    () => viewerContainer,
    () => {
        reconnectPortalTargetObserver();
    },
);
</script>
