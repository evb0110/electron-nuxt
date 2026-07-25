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
                    :disabled="disabled"
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
            :aria-disabled="disabled"
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
                                        <div class="scan-thumbnail-diagnostic-group">
                                            <h4>{{ t('scanCleanup.pages.diagnostics.modeDecision') }}</h4>
                                            <div class="scan-thumbnail-diagnostic-row">
                                                <dt>{{ t('scanCleanup.pages.diagnostics.recommendedMode') }}</dt>
                                                <dd>{{ diagnosticRecommendation(naturalPage(position)) }}</dd>
                                            </div>
                                            <div class="scan-thumbnail-diagnostic-row">
                                                <dt>{{ t('scanCleanup.pages.diagnostics.reason') }}</dt>
                                                <dd>{{ diagnosticRecommendationReason(naturalPage(position)) }}</dd>
                                            </div>
                                            <div class="scan-thumbnail-diagnostic-row">
                                                <dt>{{ t('scanCleanup.pages.diagnostics.binarization') }}</dt>
                                                <dd>{{ diagnosticBinarization(naturalPage(position)) }}</dd>
                                            </div>
                                            <template v-if="diagnosticBinarizationEvidence(naturalPage(position))">
                                                <div class="scan-thumbnail-diagnostic-row">
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.contrastIllumination') }}</dt>
                                                    <dd>{{ diagnosticBinarizationEvidence(naturalPage(position))?.contrast }}</dd>
                                                </div>
                                                <div class="scan-thumbnail-diagnostic-row">
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.edgeStroke') }}</dt>
                                                    <dd>{{ diagnosticBinarizationEvidence(naturalPage(position))?.edge }}</dd>
                                                </div>
                                                <div class="scan-thumbnail-diagnostic-row">
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.borderAgreement') }}</dt>
                                                    <dd>{{ diagnosticBinarizationEvidence(naturalPage(position))?.border }}</dd>
                                                </div>
                                            </template>
                                            <div class="scan-thumbnail-diagnostic-row">
                                                <dt>{{ t('scanCleanup.pages.diagnostics.despeckleFallback') }}</dt>
                                                <dd>{{ diagnosticDespeckleFallback(naturalPage(position)) }}</dd>
                                            </div>
                                        </div>
                                        <div class="scan-thumbnail-diagnostic-group">
                                            <h4>{{ t('scanCleanup.pages.diagnostics.contentTrim') }}</h4>
                                            <template
                                                v-for="output in diagnosticOutputs(naturalPage(position))"
                                                :key="output.half"
                                            >
                                                <div
                                                    v-if="diagnosticOutputs(naturalPage(position)).length > 1"
                                                    class="scan-thumbnail-diagnostic-note"
                                                >{{ outputHalfLabel(output.half) }}</div>
                                                <div
                                                    v-for="(trim, trimIndex) in output.contentDiagnostics?.acceptedTrims ?? []"
                                                    :key="`${output.half}-trim-${trimIndex}`"
                                                    class="scan-thumbnail-diagnostic-row"
                                                >
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.acceptedTrim') }}</dt>
                                                    <dd>{{ diagnosticTrim(trim) }}</dd>
                                                </div>
                                                <div
                                                    v-for="(block, blockIndex) in removedBlocks(output)"
                                                    :key="`${output.half}-removed-${blockIndex}`"
                                                    class="scan-thumbnail-diagnostic-row"
                                                >
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.removedBounds') }}</dt>
                                                    <dd>{{ diagnosticBlock(block) }}</dd>
                                                </div>
                                                <div
                                                    v-for="(block, blockIndex) in output.contentDiagnostics?.protectedBlocks ?? []"
                                                    :key="`${output.half}-protected-${blockIndex}`"
                                                    class="scan-thumbnail-diagnostic-row"
                                                >
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.protectedBounds') }}</dt>
                                                    <dd>{{ diagnosticBlock(block) }}</dd>
                                                </div>
                                                <div
                                                    v-if="!(output.contentDiagnostics?.acceptedTrims?.length)
                                                        && !(output.contentDiagnostics?.protectedBlocks?.length)"
                                                    class="scan-thumbnail-diagnostic-row"
                                                >
                                                    <dt>{{ t('scanCleanup.pages.diagnostics.trimResult') }}</dt>
                                                    <dd>{{ t('scanCleanup.pages.diagnostics.noTrim') }}</dd>
                                                </div>
                                            </template>
                                            <div
                                                v-if="diagnosticOutputs(naturalPage(position)).length === 0"
                                                class="scan-thumbnail-diagnostic-row"
                                            >
                                                <dt>{{ t('scanCleanup.pages.diagnostics.trimResult') }}</dt>
                                                <dd>{{ t('scanCleanup.pages.diagnostics.unavailable') }}</dd>
                                            </div>
                                        </div>
                                        <div class="scan-thumbnail-diagnostic-group">
                                            <h4>{{ t('scanCleanup.pages.diagnostics.geometry') }}</h4>
                                            <div class="scan-thumbnail-diagnostic-row">
                                                <dt>{{ t('scanCleanup.pages.diagnostics.layout') }}</dt>
                                                <dd>{{ diagnosticLayout(naturalPage(position)) }}</dd>
                                            </div>
                                            <div
                                                v-if="diagnosticsFor(naturalPage(position))?.reconciled"
                                                class="scan-thumbnail-diagnostic-note"
                                            >{{ t('scanCleanup.pages.diagnostics.reconciled') }}</div>
                                            <div
                                                v-if="diagnosticsFor(naturalPage(position))?.splitAbstained"
                                                class="scan-thumbnail-diagnostic-note"
                                            >{{ t('scanCleanup.pages.diagnostics.splitAbstained') }}</div>
                                            <div class="scan-thumbnail-diagnostic-row">
                                                <dt>{{ t('scanCleanup.pages.diagnostics.deskew') }}</dt>
                                                <dd>{{ diagnosticDeskew(naturalPage(position)) }}</dd>
                                            </div>
                                            <div
                                                v-if="diagnosticSideConfidence(naturalPage(position))"
                                                class="scan-thumbnail-diagnostic-row"
                                            >
                                                <dt>{{ t('scanCleanup.pages.diagnostics.sideConfidence') }}</dt>
                                                <dd>{{ diagnosticSideConfidence(naturalPage(position)) }}</dd>
                                            </div>
                                            <div
                                                v-if="diagnosticsFor(naturalPage(position))?.autoDewarpAttempted"
                                                class="scan-thumbnail-diagnostic-row"
                                            >
                                                <dt>{{ t('scanCleanup.pages.diagnostics.dewarp') }}</dt>
                                                <dd>{{ diagnosticDewarp(naturalPage(position)) }}</dd>
                                            </div>
                                        </div>
                                    </dl>
                                </div>
                            </template>
                        </UPopover>
                        <UPopover
                            v-if="displayedOutputMode(naturalPage(position))"
                            :open="outputModePopoverPage === naturalPage(position)"
                            portal="body"
                            :content="{side: 'right', align: 'start'}"
                            @update:open="updateOutputModePopover(naturalPage(position), $event)"
                        >
                            <button
                                type="button"
                                class="scan-thumbnail-output-mode"
                                :class="{
                                    'is-override': isOutputModeOverride(naturalPage(position)),
                                    'is-recommendation': outputModeBadgeKind(naturalPage(position)) === 'recommendation',
                                    'is-effective': outputModeBadgeKind(naturalPage(position)) === 'effective',
                                }"
                                :aria-label="outputModeAriaLabel(naturalPage(position))"
                                :aria-expanded="outputModePopoverPage === naturalPage(position)"
                                aria-haspopup="dialog"
                                :disabled="disabled || preserveOriginalQuality"
                                @click="openOutputModePopover(naturalPage(position))"
                                @keydown.esc.stop.prevent="closeOutputModePopover(naturalPage(position))"
                            >
                                <span
                                    v-if="isOutputModeOverride(naturalPage(position))"
                                    class="scan-thumbnail-output-mode-marker"
                                    aria-hidden="true"
                                />
                                {{ outputModeShortLabel(displayedOutputMode(naturalPage(position))) }}
                            </button>

                            <template #content>
                                <div
                                    class="scan-thumbnail-output-mode-popover"
                                    @click.stop
                                    @pointerdown.stop
                                    @keydown.esc.stop.prevent="closeOutputModePopover(naturalPage(position))"
                                >
                                    <p>{{ outputModeHint(naturalPage(position)) }}</p>
                                    <USelect
                                        class="scan-thumbnail-popover-output-mode-select"
                                        :model-value="pageOverride(naturalPage(position)).outputModeOverride ?? 'auto'"
                                        :items="outputModeItems"
                                        value-key="value"
                                        size="xs"
                                        portal="body"
                                        :content="{position: 'popper', side: 'bottom', align: 'start'}"
                                        :ui="overrideSelectUi"
                                        :aria-label="t('scanCleanup.pages.outputModeFor', {page: naturalPage(position)})"
                                        :disabled="disabled || preserveOriginalQuality"
                                        @keydown.esc.stop.prevent="closeOutputModePopover(naturalPage(position))"
                                        @update:model-value="updateOutputModeOverride(naturalPage(position), $event)"
                                    />
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
                        <UBadge
                            v-if="pageOverride(naturalPage(position)).excluded"
                            class="scan-thumbnail-excluded-badge"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            :aria-label="t('scanCleanup.pages.excludedFromOutput')"
                        >
                            <UIcon name="i-ph-eye-slash" aria-hidden="true" />
                            <span>{{ t('scanCleanup.pages.excludedBadge') }}</span>
                        </UBadge>
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
                        <AppTooltip
                            :text="includeLabel(naturalPage(position))"
                            usefulness="always"
                        >
                            <UButton
                                type="button"
                                class="scan-thumbnail-exclude-toggle"
                                :class="{
                                    'is-visible': selectedPages.has(naturalPage(position))
                                        || pageOverride(naturalPage(position)).excluded,
                                }"
                                :color="pageOverride(naturalPage(position)).excluded ? 'neutral' : 'primary'"
                                variant="soft"
                                size="xs"
                                square
                                :icon="pageOverride(naturalPage(position)).excluded ? 'i-ph-eye-slash' : 'i-ph-eye'"
                                role="switch"
                                :aria-checked="!pageOverride(naturalPage(position)).excluded"
                                :aria-label="includeLabel(naturalPage(position))"
                                :disabled="disabled"
                                @click="updateOverride(naturalPage(position), {
                                    excluded: !pageOverride(naturalPage(position)).excluded,
                                })"
                            />
                        </AppTooltip>
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
                    </span>
                </span>
            </template>
        </DocumentThumbnailList>
    </aside>
</template>

<script setup lang="ts">
/* eslint-disable max-lines -- This established rail co-locates its virtual-list slots, interactions, and popover styles. */
import type {
    IScanCleanupPageOverride,
    IScanCleanupContentBlockEvidence,
    IScanCleanupContentAcceptedTrim,
    IScanCleanupPageOutputDiagnostics,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
    TScanCleanupPageRotation,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupOutputModeSetting,
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
    documentOutputMode: TScanCleanupOutputModeSetting;
    preserveOriginalQuality: boolean;
    recommendedOutputModes?: ReadonlyMap<number, TScanCleanupOutputMode>;
    recommendedOutputModeConfidences?: ReadonlyMap<number, number>;
    recommendedOutputModeReasons?: ReadonlyMap<number, TScanCleanupOutputModeRecommendationReason>;
    textAxes?: ReadonlyMap<number, IScanCleanupTextAxis>;
    disabled: boolean;
    processedPages?: ReadonlySet<number>;
    sourcePending?: boolean;
    detectionActive?: boolean;
    settledPages?: ReadonlySet<number>;
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
const outputModePopoverPage = ref<number | null>(null);
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
const outputModeItems = computed<Array<{
    label: string;
    value: TScanCleanupOutputMode | 'auto'
}>>(() => [
    {
        value: 'auto',
        label: t('scanCleanup.pages.outputModeFollowDocument'),
    },
    {
        value: 'bw',
        label: t('scanCleanup.output.bw'),
    },
    {
        value: 'grayscale',
        label: t('scanCleanup.output.grayscale'),
    },
    {
        value: 'color',
        label: t('scanCleanup.output.color'),
    },
    {
        value: 'mixed',
        label: t('scanCleanup.output.mixed'),
    },
]);
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

function displayedOutputMode(page: number) {
    if (props.preserveOriginalQuality) {
        return 'color';
    }
    const override = pageOverride(page).outputModeOverride;
    if (override !== undefined) {
        return override;
    }
    if (props.documentOutputMode !== 'auto') {
        return props.documentOutputMode;
    }
    return props.recommendedOutputModes?.get(page);
}

function isOutputModeOverride(page: number) {
    return !props.preserveOriginalQuality
        && pageOverride(page).outputModeOverride !== undefined;
}

function outputModeBadgeKind(page: number) {
    return !props.preserveOriginalQuality
        && props.documentOutputMode === 'auto'
        && pageOverride(page).outputModeOverride === undefined
        ? 'recommendation'
        : 'effective';
}

function outputModeShortLabel(mode: TScanCleanupOutputMode | undefined) {
    if (mode === undefined) {
        return '';
    }
    if (mode === 'bw') {
        return t('scanCleanup.output.bwShort');
    }
    if (mode === 'grayscale') {
        return t('scanCleanup.output.grayscaleShort');
    }
    if (mode === 'color') {
        return t('scanCleanup.output.colorShort');
    }
    return t('scanCleanup.output.mixedShort');
}

function outputModeHint(page: number) {
    if (props.preserveOriginalQuality) {
        return t('scanCleanup.pages.outputModeLosslessHint', {mode: outputModeLabel('color')});
    }
    const override = pageOverride(page).outputModeOverride;
    if (override !== undefined) {
        return t('scanCleanup.pages.outputModeOverrideHint', {mode: outputModeLabel(override)});
    }
    if (props.documentOutputMode !== 'auto') {
        return t('scanCleanup.pages.outputModeDocumentHint', {mode: outputModeLabel(props.documentOutputMode)});
    }
    const recommended = props.recommendedOutputModes?.get(page);
    const confidence = props.recommendedOutputModeConfidences?.get(page);
    if (recommended === undefined) {
        return t('scanCleanup.pages.outputModeRecommendationPending');
    }
    if (confidence === undefined) {
        return t('scanCleanup.pages.outputModeRecommendationHintUnknown', {mode: outputModeLabel(recommended)});
    }
    return t('scanCleanup.pages.outputModeRecommendationHintKnown', {
        mode: outputModeLabel(recommended),
        confidence: `${Math.round(confidence * 100)}%`,
    });
}

function outputModeLabel(mode: TScanCleanupOutputMode) {
    if (mode === 'bw') {
        return t('scanCleanup.output.bw');
    }
    if (mode === 'grayscale') {
        return t('scanCleanup.output.grayscale');
    }
    if (mode === 'color') {
        return t('scanCleanup.output.color');
    }
    return t('scanCleanup.output.mixed');
}

function outputModeAriaLabel(page: number) {
    return t('scanCleanup.pages.outputModeAria', {
        page,
        hint: outputModeHint(page),
    });
}

function updateOutputModeOverride(page: number, value: unknown) {
    if (value === 'auto') {
        const {
            outputModeOverride: _outputModeOverride,
            ...withoutOutputMode
        } = pageOverride(page);
        emit('update:override', page, createScanCleanupPageOverride(withoutOutputMode));
        closeOutputModePopover(page);
        return;
    }
    if ([
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(String(value))) {
        updateOverride(page, {outputModeOverride: value as TScanCleanupOutputMode});
        closeOutputModePopover(page);
    }
}

function openOutputModePopover(page: number) {
    outputModePopoverPage.value = page;
}

function closeOutputModePopover(page: number) {
    if (outputModePopoverPage.value === page) {
        outputModePopoverPage.value = null;
    }
}

function updateOutputModePopover(page: number, open: boolean) {
    if (open) {
        outputModePopoverPage.value = page;
    } else {
        closeOutputModePopover(page);
    }
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

function diagnosticRecommendation(page: number) {
    const diagnostics = diagnosticsFor(page);
    const mode = props.recommendedOutputModes?.get(page) ?? diagnostics?.recommendedOutputMode;
    const confidence = props.recommendedOutputModeConfidences?.get(page)
        ?? diagnostics?.recommendedOutputModeConfidence;
    return mode === undefined
        ? t('scanCleanup.pages.diagnostics.unavailable')
        : t('scanCleanup.pages.diagnostics.recommendedModeValue', {
            mode: outputModeLabel(mode),
            confidence: formatConfidence(confidence),
        });
}

function diagnosticRecommendationReason(page: number) {
    const reason = props.recommendedOutputModeReasons?.get(page)
        ?? diagnosticsFor(page)?.recommendedOutputModeReason;
    return reason === undefined
        ? t('scanCleanup.pages.diagnostics.unavailable')
        : t(`scanCleanup.pages.diagnostics.modeReason.${reason}`);
}

function diagnosticBinarizationEvidence(page: number) {
    const evidence = diagnosticsFor(page)?.binarizationDiagnostics;
    if (!evidence) {
        return null;
    }
    return {
        contrast: t('scanCleanup.pages.diagnostics.contrastIlluminationValue', {
            contrast: evidence.robustContrast.toFixed(1),
            illumination: evidence.illuminationDeviation.toFixed(1),
        }),
        edge: t('scanCleanup.pages.diagnostics.edgeStrokeValue', {
            edge: formatConfidence(evidence.edgeDensity),
            stroke: evidence.estimatedStrokeWidthPx.toFixed(1),
        }),
        border: t('scanCleanup.pages.diagnostics.borderAgreementValue', {
            border: formatConfidence(evidence.darkBorderCoverage),
            agreement: formatConfidence(evidence.otsuAdaptiveAgreement),
        }),
    };
}

function diagnosticOutputs(page: number) {
    return diagnosticsFor(page)?.outputDiagnostics ?? [];
}

function removedBlocks(output: IScanCleanupPageOutputDiagnostics) {
    return (output.contentDiagnostics?.acceptedTrims ?? [])
        .flatMap(trim => trim.removedBlocks);
}

function diagnosticTrim(trim: IScanCleanupContentAcceptedTrim) {
    return t('scanCleanup.pages.diagnostics.acceptedTrimValue', {
        side: t(`scanCleanup.pages.diagnostics.trimSide.${trim.side}`),
        score: formatConfidence(trim.score),
        threshold: formatConfidence(trim.threshold),
    });
}

function diagnosticBlock(block: IScanCleanupContentBlockEvidence) {
    const evidence = [
        block.pictureMaskOverlapPixels > 0 ? t('scanCleanup.pages.diagnostics.pictureEvidence') : '',
        block.headingEvidence ? t('scanCleanup.pages.diagnostics.headingEvidence') : '',
        block.grayscaleEvidence ? t('scanCleanup.pages.diagnostics.grayscaleEvidence') : '',
    ].filter(Boolean).join(', ') || t('scanCleanup.pages.diagnostics.noProtectedEvidence');
    return t('scanCleanup.pages.diagnostics.boundsValue', {
        x: Math.round(block.bounds.xPx),
        y: Math.round(block.bounds.yPx),
        width: Math.round(block.bounds.widthPx),
        height: Math.round(block.bounds.heightPx),
        evidence,
    });
}

function outputHalfLabel(half: IScanCleanupPageOutputDiagnostics['half']) {
    return {
        full: t('scanCleanup.preview.outputHalf.full'),
        left: t('scanCleanup.preview.outputHalf.left'),
        right: t('scanCleanup.preview.outputHalf.right'),
    }[half];
}

function diagnosticSideConfidence(page: number) {
    const sideConfidence = diagnosticOutputs(page)[0]?.contentDiagnostics?.sideConfidence;
    if (!sideConfidence) {
        return null;
    }
    return ([
        'left',
        'top',
        'right',
        'bottom',
    ] as const).map(side => t('scanCleanup.pages.diagnostics.sideConfidenceValue', {
        side: t(`scanCleanup.pages.diagnostics.trimSide.${side}`),
        confidence: formatConfidence(sideConfidence[side]),
    })).join(' · ');
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

// A page keeps its spinner only while its own detection work is outstanding:
// once the running job reports that page as read or analyzed it settles, even
// though the rest of the batch is still going.
function isDetectionPending(page: number) {
    return props.detectionActive === true
        && !props.classifications.has(page)
        && props.settledPages?.has(page) !== true;
}

function includeLabel(page: number) {
    return t(pageOverride(page).excluded
        ? 'scanCleanup.pages.excludedFromOutput'
        : 'scanCleanup.pages.includeInOutput');
}

function handleRowClick(position: number, event?: MouseEvent) {
    if (props.disabled) {
        return;
    }
    const intent: TScanCleanupSelectionIntent = event?.shiftKey
        ? 'range'
        : event?.ctrlKey || event?.metaKey ? 'toggle' : 'single';
    emit('select-page', naturalPage(position), intent, orderedPages.value);
}

function handleKeydown(event: KeyboardEvent) {
    if (props.disabled) {
        return;
    }
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
    container-type: inline-size;
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

.scan-thumbnail-low-confidence,
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

.scan-thumbnail-low-confidence {
    font: inherit;
    font-weight: var(--app-font-weight-heading);
}

.scan-thumbnail-diagnostics {
    flex: none;
    pointer-events: auto;
}

.scan-thumbnail-diagnostics-popover,
.scan-thumbnail-low-confidence-popover,
.scan-thumbnail-text-axis-popover,
.scan-thumbnail-output-mode-popover {
    display: grid;
    width: var(--app-scan-low-confidence-popover-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-5xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-thumbnail-diagnostics-popover dl {
    display: grid;
    gap: var(--app-space-5xl);
}

.scan-thumbnail-diagnostic-group {
    display: grid;
    gap: var(--app-space-3xl);
}

.scan-thumbnail-diagnostic-group h4 {
    margin: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-heading);
    text-transform: uppercase;
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
    max-width: 68%;
    margin-inline-start: var(--app-space-3xl);
    text-align: end;
    overflow-wrap: anywhere;
}

.scan-thumbnail-diagnostic-note {
    font-size: var(--app-text-size-kicker);
}

.scan-thumbnail-low-confidence:focus-visible,
.scan-thumbnail-text-axis:focus-visible,
.scan-thumbnail-output-mode:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-thumbnail-low-confidence-popover p,
.scan-thumbnail-text-axis-popover p,
.scan-thumbnail-output-mode-popover p {
    margin: 0;
    color: var(--ui-text-muted);
    line-height: var(--app-line-height-body);
}

.scan-thumbnail-popover-override-select,
.scan-thumbnail-popover-rotation-select,
.scan-thumbnail-popover-output-mode-select {
    width: 100%;
}

.scan-thumbnail-output-mode {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-heading);
    padding: var(--app-space-xs) var(--app-space-xl);
    pointer-events: auto;
}

.scan-thumbnail-output-mode.is-recommendation {
    border-color: var(--ui-border);
    background: var(--ui-bg-elevated);
    color: var(--ui-text-muted);
}

.scan-thumbnail-output-mode.is-effective {
    border-color: color-mix(in srgb, var(--ui-primary) 28%, var(--ui-border));
    background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg));
    color: var(--ui-text);
}

.scan-thumbnail-output-mode.is-override {
    border-color: var(--ui-primary);
    color: var(--ui-primary);
}

.scan-thumbnail-output-mode-marker {
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    flex: none;
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
}

.scan-thumbnail-excluded-badge,
.scan-thumbnail-processed,
.scan-thumbnail-rotation {
    flex: none;
}

.scan-thumbnail-excluded-badge {
    gap: var(--app-space-xs);
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

.scan-thumbnail-exclude-toggle {
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--app-transition-fast);
}

.scan-thumbnail-exclude-toggle.is-visible,
.scan-thumbnail-list :deep([data-document-thumbnail-item]:hover) .scan-thumbnail-exclude-toggle {
    opacity: 1;
    pointer-events: auto;
}

.scan-thumbnail-exclude-toggle:focus-visible {
    opacity: 1;
    pointer-events: auto;
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

@container (width <= 10rem) {
    .scan-thumbnail-rail-header {
        gap: var(--app-space-xs);
        padding-inline: var(--app-space-lg);
    }

    .scan-thumbnail-rail-heading {
        flex: none;
    }

    .scan-thumbnail-rail-heading strong {
        display: none;
    }

    .scan-thumbnail-rail-actions {
        flex: 1;
    }

    .scan-thumbnail-statuses {
        align-content: flex-start;
        flex-wrap: wrap;
        gap: var(--app-space-xs);
        padding: var(--app-space-xs);
    }

    .scan-thumbnail-classification-badge {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .scan-thumbnail-source-state {
        padding: var(--app-space-lg);
    }

    .scan-thumbnail-controls {
        flex-wrap: wrap;
    }
}
</style>
