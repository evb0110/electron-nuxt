<template>
    <UModal
        v-model:open="open"
        :title="t('crop.dialogTitle')"
        :ui="{ footer: 'justify-between', width: 'sm:max-w-lg' }"
    >
        <template #body>
            <div class="flex flex-col gap-4">
                <div
                    v-if="loading"
                    class="flex min-h-56 items-center justify-center rounded-lg border border-default bg-elevated/40 px-4 text-center text-sm text-muted"
                >
                    {{ t('common.loading') }}
                </div>

                <template v-else>
                    <div class="flex gap-4">
                        <div class="crop-preview-container">
                            <div class="crop-preview-page" :style="previewPageStyle">
                                <div
                                    v-if="previewCurrentStyle"
                                    class="crop-preview-current"
                                    :style="previewCurrentStyle"
                                />
                                <div class="crop-preview-area" :style="previewAreaStyle" />
                            </div>
                        </div>

                        <div class="flex flex-col gap-2 flex-1">
                            <p class="m-0 mb-0.5 text-xs text-muted">
                                {{ t('crop.margins') }}
                            </p>

                            <UFormField
                                v-for="field in marginFields"
                                :key="field.side"
                                :label="field.label"
                                orientation="horizontal"
                                :ui="marginFieldUi"
                            >
                                <UInputNumber
                                    :model-value="field.modelValue"
                                    :step="currentStep"
                                    :min="0"
                                    :format-options="displayNumberFormatOptions"
                                    :increment="false"
                                    :decrement="false"
                                    class="w-24"
                                    @update:model-value="updateMargin(field.side, $event)"
                                />
                            </UFormField>
                        </div>
                    </div>

                    <URadioGroup
                        v-model="unit"
                        :legend="t('crop.units')"
                        :items="unitOptions"
                        orientation="horizontal"
                        :ui="horizontalRadioGroupUi"
                    />

                    <div class="flex flex-col gap-2">
                        <URadioGroup
                            v-model="scope"
                            :legend="t('crop.applyTo')"
                            :items="scopeOptions"
                            :ui="verticalRadioGroupUi"
                        />

                        <UInput
                            v-if="scope === 'range'"
                            v-model="rangeInput"
                            :placeholder="t('crop.rangePlaceholder')"
                            class="mt-1"
                        />
                    </div>
                </template>
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="ghost"
                :label="t('crop.removeCrop')"
                :disabled="loading || cropPages.length === 0"
                @click="handleRemoveCrop"
            />
            <div class="flex gap-2">
                <UButton
                    color="neutral"
                    variant="ghost"
                    :label="t('common.cancel')"
                    @click="open = false"
                />
                <UButton
                    color="primary"
                    :label="t('crop.apply')"
                    :disabled="loading || !isValid"
                    @click="handleApply"
                />
            </div>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type {
    ICropApplyPayload,
    ICropMargins,
    ICropRemovePayload,
    IPdfBox,
    TCropScope,
    TCropUnit,
} from '@app/types/crop';
import {
    boxToDisplayNormalizedRect,
    marginsToDisplayNormalizedRect,
    normalizeCropRotation,
    pointsToUnit,
    unitStep,
    unitToPoints,
} from '@app/utils/pdfCropCoordinates';
import { parsePageRangeInput } from '@app/utils/pdfPageLabels';
import {
    createAllPageNumbers,
    expandPageRange,
    normalizeSelectedPageNumbers,
} from '@app/utils/pdfPageSelection';

interface ICropMarginField {
    side: keyof ICropMargins;
    label: string;
    modelValue: number;
}

const open = defineModel<boolean>('open', { required: true });

const {
    currentPage,
    currentVisibleBox = undefined,
    initialMargins,
    loading = false,
    mediaBox,
    rotation = undefined,
    selectedPages,
    totalPages,
} = defineProps<{
    loading?: boolean | undefined;
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
    initialMargins: ICropMargins;
    mediaBox: IPdfBox;
    currentVisibleBox?: IPdfBox | null | undefined;
    rotation?: number | undefined;
}>();

const emit = defineEmits<{
    apply: [payload: ICropApplyPayload];
    remove: [payload: ICropRemovePayload];
}>();

const { t } = useTypedI18n();

const marginFieldUi = {
    root: 'flex items-center justify-start gap-2',
    label: 'w-14 text-sm font-normal',
} as const;

const horizontalRadioGroupUi = {
    fieldset: 'items-center gap-x-3',
    legend: 'm-0 text-xs text-muted font-normal',
    item: 'items-center',
    wrapper: 'ms-1',
    label: 'font-normal',
} as const;

const verticalRadioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'mb-0.5 text-xs text-muted font-normal',
    item: 'items-center',
    label: 'font-normal',
} as const;

const margins = reactive<ICropMargins>({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
});
const marginsDirty = ref(false);

const unit = ref<TCropUnit>('pt');
const scope = ref<TCropScope>('current');
const rangeInput = ref('');

const normalizedSelectedPages = computed(() =>
    normalizeSelectedPageNumbers(selectedPages, totalPages),
);

const currentStep = computed(() => unitStep(unit.value));

const displayTop = computed(() => formatDisplay(margins.top));
const displayBottom = computed(() => formatDisplay(margins.bottom));
const displayLeft = computed(() => formatDisplay(margins.left));
const displayRight = computed(() => formatDisplay(margins.right));

const displayNumberFormatOptions = computed(() => ({ maximumFractionDigits: unit.value === 'in' ? 2 : 1 }));

const marginFields = computed<ICropMarginField[]>(() => [
    {
        side: 'top',
        label: t('crop.marginTop'),
        modelValue: displayTop.value,
    },
    {
        side: 'bottom',
        label: t('crop.marginBottom'),
        modelValue: displayBottom.value,
    },
    {
        side: 'left',
        label: t('crop.marginLeft'),
        modelValue: displayLeft.value,
    },
    {
        side: 'right',
        label: t('crop.marginRight'),
        modelValue: displayRight.value,
    },
]);

const unitOptions = computed(() => [
    {
        value: 'pt',
        label: t('crop.unitPoints'),
    },
    {
        value: 'mm',
        label: t('crop.unitMillimeters'),
    },
    {
        value: 'in',
        label: t('crop.unitInches'),
    },
]);

const scopeOptions = computed(() => {
    const options = [
        {
            value: 'all',
            label: t('crop.scopeAll', { count: totalPages }),
        },
        {
            value: 'current',
            label: t('crop.scopeCurrent', { page: currentPage }),
        },
        {
            value: 'even',
            label: t('crop.scopeEven'),
        },
        {
            value: 'odd',
            label: t('crop.scopeOdd'),
        },
        {
            value: 'range',
            label: t('crop.scopeRange'),
        },
    ];

    if (normalizedSelectedPages.value.length > 0) {
        options.push({
            value: 'selected',
            label: t('crop.scopeSelected', { count: normalizedSelectedPages.value.length }),
        });
    }

    return options;
});

function formatDisplay(pts: number) {
    const value = pointsToUnit(pts, unit.value);
    const precision = unit.value === 'in' ? 2 : 1;
    return parseFloat(value.toFixed(precision));
}

function updateMargin(side: keyof ICropMargins, displayValue: number | null) {
    const numValue = displayValue ?? Number.NaN;
    if (Number.isFinite(numValue) && numValue >= 0) {
        margins[side] = unitToPoints(numValue, unit.value);
        marginsDirty.value = true;
    }
}

const previewAreaStyle = computed(() => {
    const rect = marginsToDisplayNormalizedRect(
        margins,
        mediaBox,
        rotation ?? 0,
    );
    return {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
    };
});

const previewCurrentStyle = computed(() => {
    if (!currentVisibleBox) {
        return null;
    }

    const rect = boxToDisplayNormalizedRect(
        currentVisibleBox,
        mediaBox,
        rotation ?? 0,
    );
    return {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
    };
});

const previewPageStyle = computed(() => {
    const normalizedRotation = normalizeCropRotation(rotation ?? 0);
    const isQuarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
    const width = Math.max(isQuarterTurn ? mediaBox.height : mediaBox.width, 1);
    const height = Math.max(isQuarterTurn ? mediaBox.width : mediaBox.height, 1);
    return { aspectRatio: `${width} / ${height}` };
});

const isValid = computed(() => {
    const cropWidth = mediaBox.width - margins.left - margins.right;
    const cropHeight = mediaBox.height - margins.top - margins.bottom;
    return cropWidth > 0 && cropHeight > 0 && cropPages.value.length > 0;
});

const rangePages = computed(() => {
    return expandPageRange(parsePageRangeInput(rangeInput.value, totalPages));
});

const cropPages = computed((): number[] => {
    switch (scope.value) {
        case 'all': return createAllPageNumbers(totalPages);
        case 'current': return [currentPage];
        case 'even': return createAllPageNumbers(totalPages).filter(page => page % 2 === 0);
        case 'odd': return createAllPageNumbers(totalPages).filter(page => page % 2 !== 0);
        case 'range': return rangePages.value ?? [];
        case 'selected': return normalizedSelectedPages.value;
        default: return [];
    }
});

function syncMarginsFromProps() {
    margins.top = initialMargins.top;
    margins.bottom = initialMargins.bottom;
    margins.left = initialMargins.left;
    margins.right = initialMargins.right;
    marginsDirty.value = false;
}

function handleApply() {
    if (!isValid.value) {
        return;
    }

    emit('apply', {
        margins: { ...margins },
        pages: cropPages.value,
    });
    open.value = false;
}

function handleRemoveCrop() {
    const pages = cropPages.value;
    if (pages.length === 0) {
        return;
    }

    emit('remove', { pages });
    open.value = false;
}

watch(open, (isOpen) => {
    if (!isOpen) {
        marginsDirty.value = false;
        return;
    }
    syncMarginsFromProps();
    scope.value = 'current';
    rangeInput.value = '';
});

watch(() => loading, (loading, previousLoading) => {
    if (!open.value || loading || !previousLoading) {
        return;
    }
    syncMarginsFromProps();
});

watch(() => initialMargins, () => {
    if (!open.value || loading || marginsDirty.value) {
        return;
    }
    syncMarginsFromProps();
}, { deep: true });

watch(normalizedSelectedPages, (pages) => {
    if (scope.value === 'selected' && pages.length === 0) {
        scope.value = 'all';
    }
});
</script>

<style scoped>
.crop-preview-container {
    width: 120px;
    flex-shrink: 0;
}

.crop-preview-page {
    position: relative;
    width: 100%;
    aspect-ratio: 210 / 297;
    border: 1px solid var(--ui-border);
    border-radius: var(--radius-sm);
    background: var(--ui-bg);
    overflow: hidden;
}

.crop-preview-area {
    position: absolute;
    background: var(--ui-primary);
    opacity: 0.15;
    border: 1.5px solid var(--ui-primary);
}

.crop-preview-current {
    position: absolute;
    border: 1px dashed color-mix(in oklab, var(--ui-border) 70%, var(--ui-text-muted) 30%);
    background: color-mix(in oklab, var(--ui-bg-muted) 65%, transparent);
}
</style>
