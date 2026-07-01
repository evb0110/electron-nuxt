<template>
    <UModal
        v-model:open="open"
        :title="t('djvu.convertDialog.title')"
        :ui="{ footer: 'justify-end gap-2' }"
    >
        <template #body>
            <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-1">
                    <div class="convert-info-row">
                        <span class="convert-info-label">{{ t('djvu.convertDialog.file') }}</span>
                        <span class="convert-info-value">{{ fileName }}</span>
                    </div>
                    <div
                        v-if="info"
                        class="convert-info-row"
                    >
                        <span class="convert-info-label">{{ t('djvu.convertDialog.pages') }}</span>
                        <span class="convert-info-value">{{ info.pageCount }}</span>
                    </div>
                    <div
                        v-if="info"
                        class="convert-info-row"
                    >
                        <span class="convert-info-label">{{ t('djvu.convertDialog.sourceResolution') }}</span>
                        <span class="convert-info-value">{{ info.sourceDpi }} {{ t('common.unitDpi') }}</span>
                    </div>
                </div>

                <UAlert
                    v-if="largeDocumentWarning"
                    color="warning"
                    variant="soft"
                    :description="largeDocumentWarning"
                    :ui="{ title: 'sr-only' }"
                />

                <div class="convert-presets flex flex-col gap-2">
                    <URadioGroup
                        v-model="selectedSubsample"
                        :legend="t('djvu.convertDialog.quality')"
                        :items="resolvedEstimates"
                        value-key="value"
                        variant="card"
                        :ui="presetRadioGroupUi"
                    >
                        <template #label="{ item }">
                            <span class="convert-preset-label">
                                {{ item.label }}
                                <span class="convert-preset-dpi">{{ item.resultingDpi }} {{ t('common.unitDpi') }}</span>
                            </span>
                        </template>
                        <template #description="{ item }">
                            <span class="convert-preset-description">
                                {{ item.description }}
                                <span v-if="item.estimatedBytes > 0">
                                    — ~{{ formatBytes(item.estimatedBytes) }}
                                </span>
                            </span>
                        </template>
                    </URadioGroup>
                    <div
                        v-if="estimatesLoading"
                        class="convert-preset-loading"
                    >
                        <AppSpinner size="xs" tone="muted" />
                        {{ t('djvu.convertDialog.estimating') }}
                    </div>
                </div>

                <div
                    v-if="info?.hasBookmarks"
                    class="convert-option"
                >
                    <UCheckbox
                        v-model="preserveBookmarks"
                        :label="t('djvu.convertDialog.preserveBookmarks')"
                    />
                </div>
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="close"
            />
            <UButton
                :label="t('common.convert')"
                color="primary"
                :disabled="estimatesLoading"
                @click="handleConvert"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">

import type { TDocumentRef } from '@contracts/documentRef';
import {
    evaluateDjvuPdfConversionPolicy,
    resolveRecommendedDjvuPdfSubsample,
} from '@contracts/djvuConversionPolicy';
import AppSpinner from '@app/components/AppSpinner.vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';

const { t } = useTypedI18n();

const { djvuPath } = defineProps<{djvuPath: TDocumentRef | null;}>();

const emit = defineEmits<{convert: [subsample: number, preserveBookmarks: boolean];}>();

const open = defineModel<boolean>('open', { required: true });

interface IInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
}

interface IEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

interface IResolvedEstimate extends IEstimate {
    value: number;
    disabled?: boolean;
}

const info = ref<IInfo | null>(null);
const estimates = ref<IEstimate[]>([]);
const estimatesLoading = ref(false);
const selectedSubsample = ref(1);
const preserveBookmarks = ref(true);
const presetRadioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'convert-presets-title',
    item: 'cursor-pointer',
    label: 'font-normal',
    description: 'text-xs',
} as const;

const resolvedEstimates = computed<IResolvedEstimate[]>(() => estimates.value.map((estimate) => {
    const policy = resolvePolicyForSubsample(estimate.subsample);
    return {
        ...estimate,
        value: estimate.subsample,
        label: estimate.label || resolveEstimateLabel(estimate.subsample),
        description:
            estimate.description || resolveEstimateDescription(estimate.subsample),
        ...(policy && !policy.isAllowed ? { disabled: true } : {}),
    };
}));
const selectedConversionPolicy = computed(() => resolvePolicyForSubsample(selectedSubsample.value));
const largeDocumentWarning = computed(() => {
    if (!info.value) {
        return null;
    }

    if (selectedConversionPolicy.value && !selectedConversionPolicy.value.isAllowed) {
        return t('djvu.convertDialog.largeDocumentHigh');
    }

    if (info.value.pageCount >= 700) {
        return t('djvu.convertDialog.largeDocumentHigh');
    }

    if (info.value.pageCount >= 250) {
        return t('djvu.convertDialog.largeDocumentMedium');
    }

    return null;
});

const fileName = computed(() => getDocumentRefBaseName(djvuPath) ?? '');

function formatBytes(bytes: number) {
    if (bytes < 1024) {
        return `${bytes} ${t('common.unitByte')}`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} ${t('common.unitKilobyte')}`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('common.unitMegabyte')}`;
}

function resolveEstimateLabel(subsample: number) {
    switch (subsample) {
        case 1:
            return t('djvu.convertDialog.fullQuality');
        case 2:
            return t('djvu.convertDialog.goodQuality');
        default:
            return t('djvu.convertDialog.compact');
    }
}

function resolveEstimateDescription(subsample: number) {
    switch (subsample) {
        case 1:
            return t('djvu.convertDialog.original');
        case 2:
            return t('djvu.convertDialog.halfResolution');
        default:
            return t('djvu.convertDialog.quarterResolution');
    }
}

function resolvePolicyForSubsample(subsample: number) {
    if (!info.value) {
        return null;
    }

    return evaluateDjvuPdfConversionPolicy({
        pageCount: info.value.pageCount,
        sourceDpi: info.value.sourceDpi,
    }, subsample);
}

function resolvePageCountDefaultSubsample(pageCount: number) {
    if (pageCount >= 700) {
        return 4;
    }

    if (pageCount >= 250) {
        return 2;
    }

    return 1;
}

function resolveDefaultSubsample(pageCount: number, sourceDpi: number) {
    return Math.max(
        resolvePageCountDefaultSubsample(pageCount),
        resolveRecommendedDjvuPdfSubsample({
            pageCount,
            sourceDpi,
        }),
    );
}

watch(open, async (isOpen, _wasOpen, onCleanup) => {
    if (!isOpen || !djvuPath) {
        return;
    }

    let isCurrentRequest = true;
    const requestPath = djvuPath;
    onCleanup(() => {
        isCurrentRequest = false;
    });

    selectedSubsample.value = 1;
    preserveBookmarks.value = true;
    info.value = null;
    estimates.value = [];

    try {
        const djvu = getDjvuCapability();
        const djvuInfo = await djvu.getInfo(requestPath);
        if (!isCurrentRequest) {
            return;
        }
        info.value = djvuInfo;
        selectedSubsample.value = resolveDefaultSubsample(djvuInfo.pageCount, djvuInfo.sourceDpi);

        estimatesLoading.value = true;
        const sizeEstimates = await djvu.estimateSizes(requestPath);
        if (!isCurrentRequest) {
            return;
        }
        estimates.value = sizeEstimates;
    } catch (error) {
        if (!isCurrentRequest) {
            return;
        }
        BrowserLogger.warn('djvu-convert-dialog', 'Failed to load DjVu conversion estimates', {
            path: requestPath,
            error,
        });
    } finally {
        if (isCurrentRequest) {
            estimatesLoading.value = false;
        }
    }
});

function handleConvert() {
    const policy = selectedConversionPolicy.value;
    if (policy && !policy.isAllowed) {
        selectedSubsample.value = policy.recommendedSubsample;
    }
    open.value = false;
    emit('convert', selectedSubsample.value, preserveBookmarks.value);
}
</script>

<style lang="scss" scoped>
.convert-info-row {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: start;
    gap: var(--app-space-3xl);
    font-size: var(--app-text-size-body-sm);
}

.convert-info-label {
    min-width: 0;
    color: var(--ui-text-muted);
}

.convert-info-value {
    min-width: 0;
    color: var(--ui-text);
    font-weight: var(--app-font-weight-medium);
    overflow-wrap: anywhere;
}

:deep(.convert-presets-title) {
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-semibold);
    color: var(--ui-text);
}

.convert-preset-label {
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-medium);
    color: var(--ui-text);
}

.convert-preset-dpi {
    color: var(--ui-text-muted);
    font-weight: normal;
    margin-left: var(--app-space-sm);
    font-size: var(--app-text-size-kicker);
}

.convert-preset-description {
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    margin-top: var(--app-space-3xs);
}

.convert-preset-loading {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xl);
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    padding: var(--app-space-3xl) 0;
}

.convert-option {
    padding-top: var(--app-space-sm);
}
</style>
