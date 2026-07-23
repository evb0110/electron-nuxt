<template>
    <aside class="scan-thumbnail-rail" :aria-label="t('scanCleanup.pages.title')">
        <header class="scan-thumbnail-rail-header">
            <div class="scan-thumbnail-rail-heading">
                <strong>{{ t('scanCleanup.pages.title') }}</strong>
                <span :aria-label="t('scanCleanup.pages.count', {count: totalPages})">{{ totalPages }}</span>
            </div>
            <div class="scan-thumbnail-rail-actions">
                <USelect
                    v-model="sortMode"
                    class="scan-thumbnail-sort"
                    :items="sortItems"
                    value-key="value"
                    size="xs"
                    portal="body"
                    :ui="{content: 'min-w-fit'}"
                    :aria-label="t('scanCleanup.pages.sort.label')"
                />
            </div>
        </header>

        <div
            v-if="!source"
            class="scan-thumbnail-source-state"
            :class="{'is-error': !sourcePending}"
            :role="sourcePending ? 'status' : 'alert'"
            :aria-live="sourcePending ? 'polite' : 'assertive'"
        >
            <UIcon
                :name="sourcePending ? 'i-ph-circle-notch' : 'i-ph-warning-circle'"
                :class="{'is-spinning': sourcePending}"
            />
            <strong>{{ sourcePending
                ? t('scanCleanup.pages.sourceLoading')
                : t('scanCleanup.pages.sourceUnavailable') }}</strong>
            <span v-if="!sourcePending">{{ t('scanCleanup.pages.sourceUnavailableHint') }}</span>
        </div>

        <DocumentThumbnailList
            v-else
            class="scan-thumbnail-list"
            :source="orderedSource"
            :current-page="leaderPosition"
            :selected-pages="selectedPositions"
            :item-metrics-key="leaderPosition"
            item-tag="div"
            role="listbox"
            aria-multiselectable="true"
            :aria-label="t('scanCleanup.pages.title')"
            tabindex="0"
            @go-to-page="handleRowClick"
            @keydown="handleKeydown"
        >
            <template #overlay="{pageNumber: position}">
                <div
                    class="scan-thumbnail-overlay"
                    :class="{'is-excluded': pageOverride(naturalPage(position)).excluded}"
                    :data-page-number="naturalPage(position)"
                    :data-classification="classificationKind(naturalPage(position))"
                >
                    <div
                        class="scan-thumbnail-statuses"
                        @click.stop
                        @pointerdown.stop
                    >
                        <UBadge class="scan-thumbnail-classification-badge" color="neutral" variant="soft" size="sm">
                            <span
                                v-if="isDetectionPending(naturalPage(position))"
                                class="scan-thumbnail-detection-pending"
                                role="status"
                                :aria-label="t('scanCleanup.pages.detectionPending', {page: naturalPage(position)})"
                            >
                                <UIcon name="i-ph-circle-notch" class="is-spinning" aria-hidden="true" />
                            </span>
                            <template v-else>{{ statusLabel(naturalPage(position)) }}</template>
                        </UBadge>
                        <UPopover
                            v-if="diagnosticsFor(naturalPage(position))"
                            :open="diagnosticsPopoverPage === naturalPage(position)"
                            portal="body"
                            :content="{side: 'right', align: 'start'}"
                            @update:open="updateDiagnosticsPopover(naturalPage(position), $event)"
                        >
                            <UButton
                                type="button"
                                class="scan-thumbnail-diagnostics"
                                color="neutral"
                                variant="soft"
                                size="xs"
                                square
                                icon="i-ph-info"
                                :aria-label="t('scanCleanup.pages.diagnostics.open', {page: naturalPage(position)})"
                                :aria-expanded="diagnosticsPopoverPage === naturalPage(position)"
                                aria-haspopup="dialog"
                                :disabled="disabled"
                            />
                            <template #content>
                                <div
                                    class="scan-thumbnail-diagnostics-popover"
                                    @click.stop
                                    @pointerdown.stop
                                    @keydown.esc.stop.prevent="closeDiagnosticsPopover(naturalPage(position))"
                                >
                                    <strong>{{ t('scanCleanup.pages.diagnostics.title', {
                                        page: naturalPage(position),
                                    }) }}</strong>
                                    <dl>
                                        <div class="scan-thumbnail-diagnostic-row">
                                            <dt>{{ t('scanCleanup.pages.diagnostics.layout') }}</dt>
                                            <dd>{{ diagnosticLayout(naturalPage(position)) }}</dd>
                                        </div>
                                        <div
                                            v-if="diagnosticsFor(naturalPage(position))?.reconciled"
                                            class="scan-thumbnail-diagnostic-note"
                                        >
                                            {{ t('scanCleanup.pages.diagnostics.reconciled') }}
                                        </div>
                                        <div
                                            v-if="diagnosticsFor(naturalPage(position))?.splitAbstained"
                                            class="scan-thumbnail-diagnostic-note"
                                        >
                                            {{ t('scanCleanup.pages.diagnostics.splitAbstained') }}
                                        </div>
                                        <div class="scan-thumbnail-diagnostic-row">
                                            <dt>{{ t('scanCleanup.pages.diagnostics.deskew') }}</dt>
                                            <dd>{{ diagnosticDeskew(naturalPage(position)) }}</dd>
                                        </div>
                                        <div class="scan-thumbnail-diagnostic-row">
                                            <dt>{{ t('scanCleanup.pages.diagnostics.binarization') }}</dt>
                                            <dd>{{ diagnosticBinarization(naturalPage(position)) }}</dd>
                                        </div>
                                        <div class="scan-thumbnail-diagnostic-row">
                                            <dt>{{ t('scanCleanup.pages.diagnostics.despeckleFallback') }}</dt>
                                            <dd>{{ diagnosticDespeckleFallback(naturalPage(position)) }}</dd>
                                        </div>
                                        <div
                                            v-if="diagnosticsFor(naturalPage(position))?.autoDewarpAttempted"
                                            class="scan-thumbnail-diagnostic-row"
                                        >
                                            <dt>{{ t('scanCleanup.pages.diagnostics.dewarp') }}</dt>
                                            <dd>{{ diagnosticDewarp(naturalPage(position)) }}</dd>
                                        </div>
                                    </dl>
                                </div>
                            </template>
                        </UPopover>
                        <AppTooltip
                            v-if="isLowConfidence(naturalPage(position))"
                            :text="lowConfidenceHint(naturalPage(position))"
                            usefulness="always"
                        >
                            <UPopover
                                :open="lowConfidencePopoverPage === naturalPage(position)"
                                portal="body"
                                :content="{side: 'right', align: 'start'}"
                                @update:open="updateLowConfidencePopover(naturalPage(position), $event)"
                            >
                                <button
                                    type="button"
                                    class="scan-thumbnail-low-confidence"
                                    :aria-label="lowConfidenceHint(naturalPage(position))"
                                    :aria-expanded="lowConfidencePopoverPage === naturalPage(position)"
                                    aria-haspopup="dialog"
                                    :disabled="disabled"
                                    @click="openLowConfidencePopover(naturalPage(position))"
                                    @keydown.esc.stop.prevent="closeLowConfidencePopover(naturalPage(position))"
                                >?</button>

                                <template #content>
                                    <div
                                        class="scan-thumbnail-low-confidence-popover"
                                        @click.stop
                                        @pointerdown.stop
                                        @keydown.esc.stop.prevent="closeLowConfidencePopover(naturalPage(position))"
                                    >
                                        <p>{{ lowConfidenceHint(naturalPage(position)) }}</p>
                                        <USelect
                                            class="scan-thumbnail-popover-override-select"
                                            :model-value="pageOverride(naturalPage(position)).layoutOverride"
                                            :items="overrideItems"
                                            value-key="value"
                                            size="xs"
                                            portal="body"
                                            :content="{position: 'popper', side: 'bottom', align: 'start'}"
                                            :ui="overrideSelectUi"
                                            :aria-label="t('scanCleanup.pages.overrideFor', {page: naturalPage(position)})"
                                            :disabled="disabled"
                                            @keydown.esc.stop.prevent="closeLowConfidencePopover(naturalPage(position))"
                                            @update:model-value="updateOverride(naturalPage(position), {layoutOverride: $event})"
                                        />
                                    </div>
                                </template>
                            </UPopover>
                        </AppTooltip>
                        <AppTooltip
                            v-if="showsSidewaysHint(naturalPage(position))"
                            :text="t('scanCleanup.pages.textAxisHint')"
                            usefulness="always"
                        >
                            <UPopover
                                :open="textAxisPopoverPage === naturalPage(position)"
                                portal="body"
                                :content="{side: 'right', align: 'start'}"
                                @update:open="updateTextAxisPopover(naturalPage(position), $event)"
                            >
                                <button
                                    type="button"
                                    class="scan-thumbnail-text-axis"
                                    :aria-label="t('scanCleanup.pages.textAxisAria', {page: naturalPage(position)})"
                                    :aria-expanded="textAxisPopoverPage === naturalPage(position)"
                                    aria-haspopup="dialog"
                                    :disabled="disabled"
                                    @click="openTextAxisPopover(naturalPage(position))"
                                    @keydown.esc.stop.prevent="closeTextAxisPopover(naturalPage(position))"
                                >
                                    <UIcon name="i-ph-arrows-clockwise" aria-hidden="true" />
                                </button>

                                <template #content>
                                    <div
                                        class="scan-thumbnail-text-axis-popover"
                                        @click.stop
                                        @pointerdown.stop
                                        @keydown.esc.stop.prevent="closeTextAxisPopover(naturalPage(position))"
                                    >
                                        <p>{{ t('scanCleanup.pages.textAxisHint') }}</p>
                                        <USelect
                                            class="scan-thumbnail-popover-rotation-select"
                                            :model-value="pageOverride(naturalPage(position)).rotationDegrees"
                                            :items="rotationItems"
                                            value-key="value"
                                            size="xs"
                                            portal="body"
                                            :content="{position: 'popper', side: 'bottom', align: 'start'}"
                                            :ui="overrideSelectUi"
                                            :aria-label="t('scanCleanup.pages.rotationFor', {page: naturalPage(position)})"
                                            :disabled="disabled"
                                            @keydown.esc.stop.prevent="closeTextAxisPopover(naturalPage(position))"
                                            @update:model-value="updateRotationOverride(naturalPage(position), $event)"
                                        />
                                    </div>
                                </template>
                            </UPopover>
                        </AppTooltip>
                        <UIcon
                            v-if="pageOverride(naturalPage(position)).excluded"
                            name="i-ph-eye-slash"
                            class="scan-thumbnail-excluded-icon"
                            :aria-label="t('scanCleanup.pages.excludedFromOutput')"
                        />
                        <span
                            v-if="pageOverride(naturalPage(position)).rotationDegrees !== 0"
                            class="scan-thumbnail-rotation"
                        >
                            <UIcon name="i-ph-arrow-clockwise" />
                            {{ pageOverride(naturalPage(position)).rotationDegrees }}°
                        </span>
                        <UIcon
                            v-if="processedPages?.has(naturalPage(position))"
                            name="i-ph-check-circle"
                            class="scan-thumbnail-processed"
                            :aria-label="t('scanCleanup.pages.processed')"
                        />
                    </div>
                </div>
            </template>
            <template #label="{pageNumber: position}">
                <span class="scan-thumbnail-label-band">
                    <span
                        class="scan-thumbnail-page-number"
                        :class="{'is-excluded': pageOverride(naturalPage(position)).excluded}"
                    >{{ naturalPage(position) }}</span>
                    <span
                        v-if="naturalPage(position) === selectionLeader"
                        class="scan-thumbnail-controls"
                        @click.stop
                        @pointerdown.stop
                    >
                        <USelect
                            class="scan-thumbnail-override-select"
                            :model-value="pageOverride(naturalPage(position)).layoutOverride"
                            :items="overrideItems"
                            value-key="value"
                            size="xs"
                            portal="body"
                            :content="{position: 'popper', side: 'bottom', align: 'start'}"
                            :ui="overrideSelectUi"
                            :aria-label="t('scanCleanup.pages.overrideFor', {page: naturalPage(position)})"
                            :disabled="disabled"
                            @update:model-value="updateOverride(naturalPage(position), {layoutOverride: $event})"
                        />
                        <AppTooltip :text="t('scanCleanup.pages.rotateCurrent', {rotation: pageOverride(naturalPage(position)).rotationDegrees})">
                            <UButton
                                type="button"
                                color="neutral"
                                variant="soft"
                                size="xs"
                                square
                                icon="i-ph-arrow-clockwise"
                                :aria-label="t('scanCleanup.pages.rotateCurrent', {rotation: pageOverride(naturalPage(position)).rotationDegrees})"
                                :disabled="disabled"
                                @click="rotate(naturalPage(position))"
                            />
                        </AppTooltip>
                        <AppTooltip :text="includeLabel(naturalPage(position))">
                            <UButton
                                type="button"
                                :color="pageOverride(naturalPage(position)).excluded ? 'neutral' : 'primary'"
                                variant="soft"
                                size="xs"
                                square
                                :icon="pageOverride(naturalPage(position)).excluded ? 'i-ph-eye-slash' : 'i-ph-eye'"
                                role="switch"
                                :aria-checked="!pageOverride(naturalPage(position)).excluded"
                                :aria-label="includeLabel(naturalPage(position))"
                                :disabled="disabled"
                                @click="updateOverride(naturalPage(position), {excluded: !pageOverride(naturalPage(position)).excluded})"
                            />
                        </AppTooltip>
                    </span>
                </span>
            </template>
        </DocumentThumbnailList>
    </aside>
</template>

<script setup lang="ts">
import type {
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
    TScanCleanupPageRotation,
    IScanCleanupTextAxis,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import type {TScanCleanupSelectionIntent} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';

type TScanCleanupRailSort = 'natural' | 'classification' | 'confidence';
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const PAGE_KEYBOARD_STEP = 5;

const props = defineProps<{
    source: IDocumentPageSource | null;
    totalPages: number;
    selectionLeader: number;
    selectedPages: ReadonlySet<number>;
    overrides: TScanCleanupPageOverrides;
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    confidences: ReadonlyMap<number, number>;
    diagnostics?: ReadonlyMap<number, IScanCleanupPreviewPageMetadata>;
    textAxes?: ReadonlyMap<number, IScanCleanupTextAxis>;
    disabled: boolean;
    processedPages?: ReadonlySet<number>;
    sourcePending?: boolean;
    detectionActive?: boolean;
}>();
const emit = defineEmits<{
    'select-page': [page: number, intent: TScanCleanupSelectionIntent, orderedPages: readonly number[]];
    'update:override': [page: number, value: IScanCleanupPageOverride];
}>();
const {t} = useTypedI18n();
const sortMode = ref<TScanCleanupRailSort>('natural');
const lowConfidencePopoverPage = ref<number | null>(null);
const textAxisPopoverPage = ref<number | null>(null);
const diagnosticsPopoverPage = ref<number | null>(null);
const sortItems = computed(() => [
    {
        value: 'natural' as const,
        label: t('scanCleanup.pages.sort.natural'),
    },
    {
        value: 'classification' as const,
        label: t('scanCleanup.pages.sort.classification'),
    },
    {
        value: 'confidence' as const,
        label: t('scanCleanup.pages.sort.confidence'),
    },
]);
const overrideItems = computed<Array<{
    label: string;
    value: TScanCleanupPageLayoutOverride
}>>(() => [
    {
        value: 'auto',
        label: t('scanCleanup.pages.override.auto'),
    },
    {
        value: 'single',
        label: t('scanCleanup.pages.override.single'),
    },
    {
        value: 'spread',
        label: t('scanCleanup.pages.override.spread'),
    },
    {
        value: 'keep-left',
        label: t('scanCleanup.pages.override.keepLeft'),
    },
    {
        value: 'keep-right',
        label: t('scanCleanup.pages.override.keepRight'),
    },
]);
const rotationItems = computed<Array<{
    label: string;
    value: TScanCleanupPageRotation
}>>(() => [
    0,
    90,
    180,
    270,
].map(value => ({
    value: value as TScanCleanupPageRotation,
    label: `${value}°`,
})));
const overrideSelectUi = {
    content: 'scan-thumbnail-override-menu w-auto min-w-(--reka-select-trigger-width)',
    itemLabel: 'overflow-visible whitespace-nowrap text-clip',
    itemWrapper: 'min-w-max',
};
const classificationRank: Record<IScanCleanupPreviewMetadata['layoutClassification'], number> = {
    'single-uncut-page': 0,
    'page-with-offcut': 1,
    'two-page-spread': 2,
};
const orderedPages = computed(() => {
    const pages = Array.from({length: props.source?.pageCount ?? props.totalPages}, (_, index) => index + 1);
    if (sortMode.value === 'classification') {
        return pages.sort((left, right) => {
            const leftValue = props.classifications.get(left);
            const rightValue = props.classifications.get(right);
            return (leftValue === undefined ? Number.POSITIVE_INFINITY : classificationRank[leftValue])
                - (rightValue === undefined ? Number.POSITIVE_INFINITY : classificationRank[rightValue])
                || left - right;
        });
    }
    if (sortMode.value === 'confidence') {
        return pages.sort((left, right) => {
            const leftValue = props.confidences.get(left);
            const rightValue = props.confidences.get(right);
            return (leftValue ?? Number.POSITIVE_INFINITY) - (rightValue ?? Number.POSITIVE_INFINITY)
                || left - right;
        });
    }
    return pages;
});
const orderedSource = computed<IDocumentPageSource | null>(() => {
    const source = props.source;
    const order = orderedPages.value;
    if (!source) {
        return null;
    }
    function mapRequest(request: Parameters<IDocumentPageSource['renderPage']>[0]) {
        return {
            ...request,
            pageNumber: order[request.pageNumber - 1] ?? request.pageNumber,
        };
    }
    return {
        kind: source.kind,
        documentRef: source.documentRef,
        pageCount: order.length,
        getPageMetrics(position, signal) {
            return source.getPageMetrics(order[position - 1] ?? position, signal);
        },
        renderPage(request) {
            return source.renderPage(mapRequest(request));
        },
        thumbnailProvider: source.thumbnailProvider ? {renderThumbnail(request) {
            return source.thumbnailProvider!.renderThumbnail(mapRequest(request));
        }} : undefined,
        dispose() {},
    };
});
const leaderPosition = computed(() => Math.max(1, orderedPages.value.indexOf(props.selectionLeader) + 1));
const selectedPositions = computed(() => new Set(orderedPages.value.flatMap((page, index) => (
    props.selectedPages.has(page) ? [index + 1] : []
))));

function naturalPage(position: number) {
    return orderedPages.value[position - 1] ?? position;
}

function pageOverride(page: number) {
    return getScanCleanupPageOverride(props.overrides, page);
}

function updateOverride(page: number, patch: Partial<IScanCleanupPageOverride>) {
    emit('update:override', page, createScanCleanupPageOverride({
        ...pageOverride(page),
        ...patch,
    }));
}

function rotate(page: number) {
    const rotations: TScanCleanupPageRotation[] = [
        0,
        90,
        180,
        270,
    ];
    const current = pageOverride(page).rotationDegrees;
    updateOverride(page, {rotationDegrees: rotations[(rotations.indexOf(current) + 1) % rotations.length] ?? 0});
}

function updateRotationOverride(page: number, value: unknown) {
    const rotation = Number(value);
    if (![
        0,
        90,
        180,
        270,
    ].includes(rotation)) {
        return;
    }
    updateOverride(page, {rotationDegrees: rotation as TScanCleanupPageRotation});
    closeTextAxisPopover(page);
}

function classificationKind(page: number) {
    const classification = props.classifications.get(page);
    if (classification === 'two-page-spread') {
        return 'spread';
    }
    if (classification === 'page-with-offcut') {
        return 'offcut';
    }
    if (classification === 'single-uncut-page') {
        return 'single';
    }
    return 'unclassified';
}

function classificationLabel(page: number) {
    return classificationValueLabel(props.classifications.get(page));
}

function classificationValueLabel(
    classification: IScanCleanupPreviewMetadata['layoutClassification'] | undefined,
) {
    const kind = classification === 'two-page-spread'
        ? 'spread'
        : classification === 'page-with-offcut'
            ? 'offcut'
            : classification === 'single-uncut-page' ? 'single' : 'unclassified';
    if (kind === 'spread') {
        return t('scanCleanup.pages.classification.spread');
    }
    if (kind === 'offcut') {
        return t('scanCleanup.pages.classification.offcut');
    }
    if (kind === 'single') {
        return t('scanCleanup.pages.classification.single');
    }
    return '—';
}

function statusLabel(page: number) {
    const override = pageOverride(page).layoutOverride;
    if (override === 'single') {
        return t('scanCleanup.pages.override.single');
    }
    if (override === 'spread') {
        return t('scanCleanup.pages.override.spread');
    }
    if (override === 'keep-left') {
        return t('scanCleanup.pages.override.keepLeft');
    }
    if (override === 'keep-right') {
        return t('scanCleanup.pages.override.keepRight');
    }
    return classificationLabel(page);
}

function diagnosticsFor(page: number) {
    return props.diagnostics?.get(page);
}

function formatConfidence(value: number | null | undefined) {
    return value === null || value === undefined ? t('scanCleanup.pages.diagnostics.unavailable') : `${Math.round(value * 100)}%`;
}

function diagnosticLayout(page: number) {
    const diagnostics = diagnosticsFor(page);
    return diagnostics
        ? t('scanCleanup.pages.diagnostics.layoutValue', {
            layout: classificationValueLabel(diagnostics.layoutClassification),
            confidence: formatConfidence(diagnostics.layoutConfidence),
        })
        : t('scanCleanup.pages.diagnostics.unavailable');
}

function diagnosticDeskew(page: number) {
    const diagnostics = diagnosticsFor(page);
    if (diagnostics?.detectedSkewDegrees === undefined) {
        return t('scanCleanup.pages.diagnostics.unavailable');
    }
    if (diagnostics.manualSkew === true) {
        return t('scanCleanup.pages.diagnostics.deskewManualValue', {angle: diagnostics.detectedSkewDegrees.toFixed(2)});
    }
    return t('scanCleanup.pages.diagnostics.deskewValue', {
        angle: diagnostics.detectedSkewDegrees.toFixed(2),
        confidence: formatConfidence(diagnostics.skewConfidence),
    });
}

function diagnosticBinarization(page: number) {
    const diagnostics = diagnosticsFor(page);
    const route = diagnostics?.binarizationMode ?? diagnostics?.binarizationDiagnostics?.route;
    return route
        ? t(`scanCleanup.advanced.binarization.${route}`)
        : t('scanCleanup.pages.diagnostics.notApplicable');
}

function diagnosticDespeckleFallback(page: number) {
    const fallback = diagnosticsFor(page)?.despeckleFallback;
    return fallback === undefined
        ? t('scanCleanup.pages.diagnostics.notApplicable')
        : t(fallback
            ? 'scanCleanup.pages.diagnostics.fallbackUsed'
            : 'scanCleanup.pages.diagnostics.fallbackNotUsed');
}

function diagnosticDewarp(page: number) {
    const diagnostics = diagnosticsFor(page);
    return t(diagnostics?.dewarpApplied
        ? 'scanCleanup.pages.diagnostics.dewarpApplied'
        : 'scanCleanup.pages.diagnostics.dewarpGated', {confidence: formatConfidence(diagnostics?.dewarpConfidence)});
}

function closeDiagnosticsPopover(page: number) {
    if (diagnosticsPopoverPage.value === page) {
        diagnosticsPopoverPage.value = null;
    }
}

function updateDiagnosticsPopover(page: number, open: boolean) {
    diagnosticsPopoverPage.value = open ? page : null;
}

function isLowConfidence(page: number) {
    const confidence = props.confidences.get(page);
    return confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD;
}

function lowConfidenceHint(page: number) {
    return t('scanCleanup.pages.lowConfidenceHint', {classification: statusLabel(page)});
}

function openLowConfidencePopover(page: number) {
    lowConfidencePopoverPage.value = page;
}

function closeLowConfidencePopover(page: number) {
    if (lowConfidencePopoverPage.value === page) {
        lowConfidencePopoverPage.value = null;
    }
}

function updateLowConfidencePopover(page: number, open: boolean) {
    if (open) {
        lowConfidencePopoverPage.value = page;
    } else {
        closeLowConfidencePopover(page);
    }
}

function showsSidewaysHint(page: number) {
    return pageOverride(page).rotationDegrees === 0 && (props.textAxes?.get(page)?.sideways ?? false);
}

function openTextAxisPopover(page: number) {
    textAxisPopoverPage.value = page;
}

function closeTextAxisPopover(page: number) {
    if (textAxisPopoverPage.value === page) {
        textAxisPopoverPage.value = null;
    }
}

function updateTextAxisPopover(page: number, open: boolean) {
    if (open) {
        textAxisPopoverPage.value = page;
    } else {
        closeTextAxisPopover(page);
    }
}

function isDetectionPending(page: number) {
    return props.detectionActive === true && !props.classifications.has(page);
}

function includeLabel(page: number) {
    return t(pageOverride(page).excluded
        ? 'scanCleanup.pages.excludedFromOutput'
        : 'scanCleanup.pages.includeInOutput');
}

function handleRowClick(position: number, event?: MouseEvent) {
    const intent: TScanCleanupSelectionIntent = event?.shiftKey
        ? 'range'
        : event?.ctrlKey || event?.metaKey ? 'toggle' : 'single';
    emit('select-page', naturalPage(position), intent, orderedPages.value);
}

function handleKeydown(event: KeyboardEvent) {
    if (
        event.target instanceof HTMLElement
        && [
            'BUTTON',
            'INPUT',
            'SELECT',
        ].includes(event.target.tagName)
    ) {
        return;
    }
    const currentIndex = Math.max(0, orderedPages.value.indexOf(props.selectionLeader));
    let nextIndex: number | null = null;
    if (event.key === 'ArrowUp') nextIndex = currentIndex - 1;
    else if (event.key === 'ArrowDown') nextIndex = currentIndex + 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = orderedPages.value.length - 1;
    else if (event.key === 'PageUp') nextIndex = currentIndex - PAGE_KEYBOARD_STEP;
    else if (event.key === 'PageDown') nextIndex = currentIndex + PAGE_KEYBOARD_STEP;
    if (nextIndex === null || orderedPages.value.length === 0) {
        return;
    }
    event.preventDefault();
    const boundedIndex = Math.min(orderedPages.value.length - 1, Math.max(0, nextIndex));
    emit('select-page', orderedPages.value[boundedIndex]!, 'single', orderedPages.value);
}

</script>

<style scoped>
.scan-thumbnail-rail {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border-inline-end: var(--app-hairline-height) solid var(--ui-border);
    background: var(--ui-bg);
}

.scan-thumbnail-rail-header,
.scan-thumbnail-rail-heading,
.scan-thumbnail-rail-actions,
.scan-thumbnail-statuses,
.scan-thumbnail-controls {
    display: flex;
    align-items: center;
}

.scan-thumbnail-rail-header {
    box-sizing: border-box;
    height: var(--app-scan-header-height);
    min-height: var(--app-scan-header-height);
    flex: 0 0 var(--app-scan-header-height);
    justify-content: space-between;
    gap: var(--app-space-sm);
    padding-inline: var(--app-space-5xl);
    border-block-end: var(--app-hairline-height) solid var(--ui-border);
}

.scan-thumbnail-rail-heading,
.scan-thumbnail-rail-actions {
    min-width: 0;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-rail-heading strong {
    font-size: var(--app-text-size-secondary);
}

.scan-thumbnail-rail-heading span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-variant-numeric: tabular-nums;
}

.scan-thumbnail-sort {
    min-width: 0;
    flex: 1;
}

.scan-thumbnail-list {
    min-height: 0;
    flex: 1;
}

.scan-thumbnail-source-state {
    display: grid;
    min-height: 0;
    flex: 1;
    place-content: center;
    justify-items: center;
    gap: var(--app-space-3xl);
    padding: var(--app-space-12xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    text-align: center;
}

.scan-thumbnail-source-state.is-error {
    color: var(--ui-error);
}

.scan-thumbnail-detection-pending {
    display: inline-flex;
    align-items: center;
}

.scan-thumbnail-overlay {
    position: absolute;
    z-index: var(--app-z-local-raised);
    inset: var(--app-sidebar-row-padding-block);
    pointer-events: none;
}

.scan-thumbnail-overlay.is-excluded::after {
    position: absolute;
    inset: 0;
    border-radius: var(--app-thumbnail-row-radius);
    background: color-mix(in oklab, var(--ui-bg) 58%, transparent);
    content: '';
}

.scan-thumbnail-statuses {
    position: relative;
    z-index: var(--app-z-local-raised);
    justify-content: flex-end;
    gap: var(--app-space-sm);
    padding: var(--app-space-sm);
}

.scan-thumbnail-low-confidence {
    display: inline-grid;
    width: var(--app-control-height-xs);
    height: var(--app-control-height-xs);
    place-items: center;
    border: 0;
    border-radius: var(--app-radius-full);
    background: var(--ui-warning);
    color: var(--ui-bg);
    cursor: pointer;
    font: inherit;
    font-weight: var(--app-font-weight-heading);
    padding: 0;
    pointer-events: auto;
}

.scan-thumbnail-diagnostics {
    flex: none;
    pointer-events: auto;
}

.scan-thumbnail-diagnostics-popover {
    display: grid;
    width: var(--app-scan-low-confidence-popover-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-5xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-thumbnail-diagnostics-popover dl {
    display: grid;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-diagnostic-row {
    display: flex;
    justify-content: space-between;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-diagnostic-row dt,
.scan-thumbnail-diagnostic-note {
    color: var(--ui-text-muted);
}

.scan-thumbnail-diagnostic-row dd {
    margin-inline-start: var(--app-space-3xl);
    text-align: end;
}

.scan-thumbnail-diagnostic-note {
    font-size: var(--app-text-size-kicker);
}

.scan-thumbnail-text-axis {
    display: inline-grid;
    width: var(--app-control-height-xs);
    height: var(--app-control-height-xs);
    place-items: center;
    border: 0;
    border-radius: var(--app-radius-full);
    background: var(--ui-warning);
    color: var(--ui-bg);
    cursor: pointer;
    padding: 0;
    pointer-events: auto;
}

.scan-thumbnail-low-confidence:focus-visible,
.scan-thumbnail-text-axis:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-thumbnail-low-confidence-popover {
    display: grid;
    width: var(--app-scan-low-confidence-popover-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-5xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-thumbnail-text-axis-popover {
    display: grid;
    width: var(--app-scan-low-confidence-popover-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-5xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-thumbnail-low-confidence-popover p,
.scan-thumbnail-text-axis-popover p {
    margin: 0;
    color: var(--ui-text-muted);
    line-height: var(--app-line-height-body);
}

.scan-thumbnail-popover-override-select {
    width: 100%;
}

.scan-thumbnail-popover-rotation-select {
    width: 100%;
}

.scan-thumbnail-excluded-icon,
.scan-thumbnail-processed,
.scan-thumbnail-rotation {
    flex: none;
}

.scan-thumbnail-excluded-icon {
    color: var(--ui-text-muted);
}

.scan-thumbnail-processed {
    color: var(--ui-success);
}

.scan-thumbnail-rotation {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-xs);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
    padding-inline: var(--app-space-sm);
    color: var(--ui-bg);
    font-size: var(--app-text-size-kicker);
    font-variant-numeric: tabular-nums;
}

.scan-thumbnail-controls {
    width: 100%;
    box-sizing: border-box;
    gap: var(--app-space-sm);
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg-elevated);
    padding: var(--app-space-sm);
    box-shadow: var(--app-document-page-shadow);
    pointer-events: auto;
}

.scan-thumbnail-label-band {
    display: grid;
    width: 100%;
    gap: var(--app-space-sm);
    line-height: var(--app-thumbnail-min-label-height);
}

.scan-thumbnail-override-select {
    min-width: 0;
    flex: 1;
}

.scan-thumbnail-page-number {
    font-weight: var(--app-font-weight-heading);
    font-variant-numeric: tabular-nums;
}

.scan-thumbnail-page-number.is-excluded {
    color: var(--ui-text-dimmed);
    text-decoration: line-through;
}

</style>
