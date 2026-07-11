<template>
    <div class="document-viewer-chassis">
        <div id="document-viewer-chassis-sidebar" />
        <DocumentViewportHost
            :viewport-id="viewportId"
            :set-viewport="chassisAuthority.bindViewportElement"
            :class="chassisAuthority.viewportClass.value"
            :style="chassisAuthority.viewportStyle.value"
            @scroll="chassisAuthority.dispatchViewportEvent('scroll', $event)"
            @wheel="chassisAuthority.dispatchViewportEvent('wheel', $event)"
            @mousedown="chassisAuthority.dispatchViewportEvent('mousedown', $event)"
            @mousemove="chassisAuthority.dispatchViewportEvent('mousemove', $event)"
            @mouseup="chassisAuthority.dispatchViewportEvent('mouseup', $event)"
            @mouseleave="chassisAuthority.dispatchViewportEvent('mouseleave')"
            @click="chassisAuthority.dispatchViewportEvent('click', $event)"
            @dblclick="chassisAuthority.dispatchViewportEvent('dblclick', $event)"
            @contextmenu="chassisAuthority.dispatchViewportEvent('contextmenu', $event)"
            @selectstart="chassisAuthority.dispatchViewportEvent('selectstart', $event)"
        >
            <component
                :is="activeFeaturePack"
                ref="activeFeaturePackRef"
                v-bind="$attrs"
                :current-page="chassisAuthority.currentPage.value"
                @update:current-page="handleCurrentPageUpdate"
                @update:total-pages="handleTotalPagesUpdate"
            />
        </DocumentViewportHost>
    </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue';
import { createDocumentViewerExposeForwarder } from '@app/modules/workspace-shell/viewers/createDocumentViewerExposeForwarder';
import {
    createDocumentViewerChassisAuthority,
    documentViewerChassisAuthorityKey,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { TDocumentPageSourceKind } from '@app/utils/document-viewer/source/documentPageSource';
import DocumentViewportHost from '@app/utils/document-viewer/chassis/DocumentViewportHost.vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
    sourceKind: TDocumentPageSourceKind;
    rendererKind?: 'pdfjs' | 'native-pdf' | 'page-source';
    currentPage?: number;
}>();
const sourceKind = toRef(props, 'sourceKind');

const PdfFeaturePack = defineAsyncComponent(
    () => import('@app/modules/pdf-viewer/public/component-exports/pdfViewer')
        .then(componentModule => componentModule.PdfViewer),
) as Component;
const DocumentPageSourceFeaturePack = defineAsyncComponent(
    () => import('@app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue')
        .then(componentModule => componentModule.default),
) as Component;
const NativePdfFeaturePack = defineAsyncComponent(
    () => import('@app/modules/native-pdf-viewer/public/component-exports/nativePdfViewer')
        .then(componentModule => componentModule.NativePdfViewer),
) as Component;
const activeFeaturePackRef = shallowRef<Record<PropertyKey, unknown> | null>(null);
const viewportId = computed(() => (
    sourceKind.value === 'pdf' && props.rendererKind !== 'native-pdf' ? 'pdf-viewer' : undefined
));
const activeFeaturePack = computed(() => (
    props.rendererKind === 'native-pdf'
        ? NativePdfFeaturePack
        : sourceKind.value === 'pdf' ? PdfFeaturePack : DocumentPageSourceFeaturePack
));
const sourceViewerRef = computed(() => activeFeaturePackRef.value);
const chassisAuthority = createDocumentViewerChassisAuthority(sourceKind);
let handoffGeneration = 0;
provide(documentViewerChassisAuthorityKey, chassisAuthority);

watch(() => props.currentPage, (pageNumber) => {
    if (pageNumber !== undefined) {
        chassisAuthority.navigate(pageNumber);
    }
}, {immediate: true});

function handleCurrentPageUpdate(pageNumber: number) {
    chassisAuthority.navigate(pageNumber);
}

function handleTotalPagesUpdate(pageCount: number) {
    chassisAuthority.pageCount.value = Math.max(0, Math.trunc(pageCount));
    chassisAuthority.navigate(chassisAuthority.currentPage.value);
}

watch(() => [
    sourceKind.value,
    props.rendererKind,
] as const, async (nextIdentity, previousIdentity) => {
    if (nextIdentity[0] === previousIdentity?.[0] && nextIdentity[1] === previousIdentity?.[1]) {
        return;
    }
    const generation = ++handoffGeneration;
    const previousViewer = sourceViewerRef.value as {
        captureScrollSnapshot?: () => unknown;
        getCurrentPage?: () => number;
    } | null;
    const snapshot = previousViewer?.captureScrollSnapshot?.() ?? null;
    const fallbackPage = previousViewer?.getCurrentPage?.() ?? 1;
    await nextTick();
    if (generation !== handoffGeneration) {
        return;
    }
    const nextViewer = sourceViewerRef.value as {
        waitForViewerLoadSettled?: () => Promise<void>;
        restoreScrollSnapshot?: (snapshot: unknown, options: {fallbackPage: number}) => void;
        scrollToPage?: (pageNumber: number) => void;
    } | null;
    await nextViewer?.waitForViewerLoadSettled?.();
    if (generation !== handoffGeneration || sourceViewerRef.value !== nextViewer) {
        return;
    }
    if (nextViewer?.restoreScrollSnapshot) {
        nextViewer.restoreScrollSnapshot(snapshot, {fallbackPage});
    } else {
        nextViewer?.scrollToPage?.(fallbackPage);
    }
}, {flush: 'pre'});

// Preserve the established viewer port while the chassis takes ownership of source selection.
// Every property read is forwarded to the active feature pack, including reactive expose fields.
defineExpose(createDocumentViewerExposeForwarder(sourceViewerRef));
</script>

<style scoped>
.document-viewer-chassis {
    display: flex;
    width: 100%;
    height: 100%;
}

[data-document-viewer-chassis-viewport] {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: auto;
}
</style>
