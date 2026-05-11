<template>
    <UModal
        v-model:open="open"
        :title="t('djvu.convertDialog.title')"
        :ui="{ footer: 'justify-end' }"
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
                    <label class="convert-presets-title">{{ t('djvu.convertDialog.quality') }}</label>
                    <div
                        v-for="estimate in resolvedEstimates"
                        :key="estimate.subsample"
                        class="convert-preset"
                        :class="{ 'is-selected': selectedSubsample === estimate.subsample }"
                        @click="selectedSubsample = estimate.subsample"
                    >
                        <div class="convert-preset-radio">
                            <div
                                v-if="selectedSubsample === estimate.subsample"
                                class="convert-preset-radio-dot"
                            />
                        </div>
                        <div class="convert-preset-content">
                            <div class="convert-preset-label">
                                {{ estimate.label }}
                                <span class="convert-preset-dpi">{{ estimate.resultingDpi }} {{ t('common.unitDpi') }}</span>
                            </div>
                            <div class="convert-preset-description">
                                {{ estimate.description }}
                                <span v-if="estimate.estimatedBytes > 0">
                                    — ~{{ formatBytes(estimate.estimatedBytes) }}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div
                        v-if="estimatesLoading"
                        class="convert-preset-loading"
                    >
                        <UIcon
                            name="i-ph-circle-notch"
                            class="convert-loading-spinner"
                        />
                        {{ t('djvu.convertDialog.estimating') }}
                    </div>
                </div>

                <div
                    v-if="info?.hasBookmarks"
                    class="convert-option"
                >
                    <label class="convert-checkbox-label flex items-center gap-2">
                        <input
                            v-model="preserveBookmarks"
                            type="checkbox"
                        >
                        {{ t('djvu.convertDialog.preserveBookmarks') }}
                    </label>
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

import type { TDocumentRef } from '@contracts/platform-api';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getDocumentRefBaseName } from '@app/utils/document-ref';
import { getDjvuCapability } from '@app/utils/platform-djvu';

const { t } = useTypedI18n();

const props = defineProps<{djvuPath: TDocumentRef | null;}>();

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

const info = ref<IInfo | null>(null);
const estimates = ref<IEstimate[]>([]);
const estimatesLoading = ref(false);
const selectedSubsample = ref(1);
const preserveBookmarks = ref(true);

const resolvedEstimates = computed(() => estimates.value.map((estimate) => ({
    ...estimate,
    label: estimate.label || resolveEstimateLabel(estimate.subsample),
    description:
        estimate.description || resolveEstimateDescription(estimate.subsample),
})));
const largeDocumentWarning = computed(() => {
    if (!info.value) {
        return null;
    }

    if (info.value.pageCount >= 700) {
        return t('djvu.convertDialog.largeDocumentHigh');
    }

    if (info.value.pageCount >= 250) {
        return t('djvu.convertDialog.largeDocumentMedium');
    }

    return null;
});

const fileName = computed(() => getDocumentRefBaseName(props.djvuPath) ?? '');

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

function resolveDefaultSubsample(pageCount: number) {
    if (pageCount >= 700) {
        return 4;
    }

    if (pageCount >= 250) {
        return 2;
    }

    return 1;
}

watch(open, async (isOpen, _wasOpen, onCleanup) => {
    if (!isOpen || !props.djvuPath) {
        return;
    }

    let isCurrentRequest = true;
    const requestPath = props.djvuPath;
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
        selectedSubsample.value = resolveDefaultSubsample(djvuInfo.pageCount);

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
    open.value = false;
    emit('convert', selectedSubsample.value, preserveBookmarks.value);
}
</script>

<style lang="scss" scoped>
.convert-info-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
}

.convert-info-label {
    color: var(--ui-text-muted);
    min-width: 120px;
}

.convert-info-value {
    color: var(--ui-text);
    font-weight: 500;
}

.convert-presets-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--ui-text);
}

.convert-preset {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color $ease-standard;
}

.convert-preset:hover {
    border-color: var(--ui-border-hover);
}

.convert-preset.is-selected {
    border-color: var(--ui-primary);
    background: var(--ui-bg-elevated);
}

.convert-preset-radio {
    width: 16px;
    height: 16px;
    border: 2px solid var(--ui-border);
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 1px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.convert-preset.is-selected .convert-preset-radio {
    border-color: var(--ui-primary);
}

.convert-preset-radio-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ui-primary);
}

.convert-preset-content {
    flex: 1;
}

.convert-preset-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--ui-text);
}

.convert-preset-dpi {
    color: var(--ui-text-muted);
    font-weight: 400;
    margin-left: 4px;
    font-size: 12px;
}

.convert-preset-description {
    font-size: 12px;
    color: var(--ui-text-muted);
    margin-top: 2px;
}

.convert-preset-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--ui-text-muted);
    padding: 8px 0;
}

.convert-loading-spinner {
    width: 14px;
    height: 14px;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.convert-option {
    padding-top: 4px;
}

.convert-checkbox-label {
    font-size: 13px;
    color: var(--ui-text);
    cursor: pointer;
}
</style>
