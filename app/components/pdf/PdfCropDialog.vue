<template>
    <UModal
        v-model:open="open"
        :title="t('crop.dialogTitle')"
        :ui="{ footer: 'justify-between', width: 'sm:max-w-lg' }"
    >
        <template #body>
            <div class="flex flex-col gap-4">
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

                        <div class="flex items-center gap-2">
                            <span class="w-14 text-sm text-default">{{ t('crop.marginTop') }}</span>
                            <UInput
                                :model-value="displayTop"
                                type="number"
                                :step="currentStep"
                                :min="0"
                                class="w-24"
                                @update:model-value="updateMargin('top', $event)"
                            />
                        </div>

                        <div class="flex items-center gap-2">
                            <span class="w-14 text-sm text-default">{{ t('crop.marginBottom') }}</span>
                            <UInput
                                :model-value="displayBottom"
                                type="number"
                                :step="currentStep"
                                :min="0"
                                class="w-24"
                                @update:model-value="updateMargin('bottom', $event)"
                            />
                        </div>

                        <div class="flex items-center gap-2">
                            <span class="w-14 text-sm text-default">{{ t('crop.marginLeft') }}</span>
                            <UInput
                                :model-value="displayLeft"
                                type="number"
                                :step="currentStep"
                                :min="0"
                                class="w-24"
                                @update:model-value="updateMargin('left', $event)"
                            />
                        </div>

                        <div class="flex items-center gap-2">
                            <span class="w-14 text-sm text-default">{{ t('crop.marginRight') }}</span>
                            <UInput
                                :model-value="displayRight"
                                type="number"
                                :step="currentStep"
                                :min="0"
                                class="w-24"
                                @update:model-value="updateMargin('right', $event)"
                            />
                        </div>
                    </div>
                </div>

                <div class="flex items-center gap-3">
                    <p class="m-0 text-xs text-muted">
                        {{ t('crop.units') }}
                    </p>
                    <label class="flex items-center gap-1 text-sm text-default">
                        <input v-model="unit" type="radio" value="pt">
                        <span>{{ t('crop.unitPoints') }}</span>
                    </label>
                    <label class="flex items-center gap-1 text-sm text-default">
                        <input v-model="unit" type="radio" value="mm">
                        <span>{{ t('crop.unitMillimeters') }}</span>
                    </label>
                    <label class="flex items-center gap-1 text-sm text-default">
                        <input v-model="unit" type="radio" value="in">
                        <span>{{ t('crop.unitInches') }}</span>
                    </label>
                </div>

                <div class="flex flex-col gap-2">
                    <p class="m-0 mb-0.5 text-xs text-muted">
                        {{ t('crop.applyTo') }}
                    </p>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input v-model="scope" type="radio" value="all">
                        <span>{{ t('crop.scopeAll', { count: totalPages }) }}</span>
                    </label>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input v-model="scope" type="radio" value="current">
                        <span>{{ t('crop.scopeCurrent', { page: currentPage }) }}</span>
                    </label>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input v-model="scope" type="radio" value="even">
                        <span>{{ t('crop.scopeEven') }}</span>
                    </label>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input v-model="scope" type="radio" value="odd">
                        <span>{{ t('crop.scopeOdd') }}</span>
                    </label>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input v-model="scope" type="radio" value="range">
                        <span>{{ t('crop.scopeRange') }}</span>
                    </label>

                    <UInput
                        v-if="scope === 'range'"
                        v-model="rangeInput"
                        :placeholder="t('crop.rangePlaceholder')"
                        class="mt-1"
                    />

                    <label
                        v-if="normalizedSelectedPages.length > 0"
                        class="flex items-center gap-2 text-sm text-default"
                    >
                        <input v-model="scope" type="radio" value="selected">
                        <span>{{ t('crop.scopeSelected', { count: normalizedSelectedPages.length }) }}</span>
                    </label>
                </div>
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="ghost"
                :label="t('crop.removeCrop')"
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
                    :disabled="!isValid"
                    @click="handleApply"
                />
            </div>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import { uniq } from 'es-toolkit/array';
import type {
    ICropApplyPayload,
    ICropMargins,
    ICropRemovePayload,
    IPdfBox,
    TCropScope,
    TCropUnit,
} from '@app/types/crop';
import {
    boxToNormalizedRect,
    marginsToNormalizedRect,
    pointsToUnit,
    unitStep,
    unitToPoints,
} from '@app/utils/pdf-crop-coordinates';
import { parsePageRangeInput } from '@app/utils/pdf-page-labels';

const open = defineModel<boolean>('open', { required: true });

const props = defineProps<{
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
    initialMargins: ICropMargins;
    mediaBox: IPdfBox;
    currentVisibleBox?: IPdfBox | null;
}>();

const emit = defineEmits<{
    apply: [payload: ICropApplyPayload];
    remove: [payload: ICropRemovePayload];
}>();

const { t } = useTypedI18n();

const margins = reactive<ICropMargins>({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
});

const unit = ref<TCropUnit>('pt');
const scope = ref<TCropScope>('current');
const rangeInput = ref('');

const normalizedSelectedPages = computed(() =>
    uniq(props.selectedPages)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= props.totalPages)
        .sort((left, right) => left - right),
);

const currentStep = computed(() => unitStep(unit.value));

const displayTop = computed(() => formatDisplay(margins.top));
const displayBottom = computed(() => formatDisplay(margins.bottom));
const displayLeft = computed(() => formatDisplay(margins.left));
const displayRight = computed(() => formatDisplay(margins.right));

function formatDisplay(pts: number) {
    const value = pointsToUnit(pts, unit.value);
    const precision = unit.value === 'in' ? 2 : 1;
    return parseFloat(value.toFixed(precision)).toString();
}

function updateMargin(side: keyof ICropMargins, displayValue: string | number) {
    const numValue = typeof displayValue === 'string' ? parseFloat(displayValue) : displayValue;
    if (Number.isFinite(numValue) && numValue >= 0) {
        margins[side] = unitToPoints(numValue, unit.value);
    }
}

const previewAreaStyle = computed(() => {
    const rect = marginsToNormalizedRect(margins, props.mediaBox);
    return {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
    };
});

const previewCurrentStyle = computed(() => {
    if (!props.currentVisibleBox) {
        return null;
    }

    const rect = boxToNormalizedRect(props.currentVisibleBox, props.mediaBox);
    return {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
    };
});

const previewPageStyle = computed(() => {
    const width = Math.max(props.mediaBox.width, 1);
    const height = Math.max(props.mediaBox.height, 1);
    return { aspectRatio: `${width} / ${height}` };
});

const isValid = computed(() => {
    const cropWidth = props.mediaBox.width - margins.left - margins.right;
    const cropHeight = props.mediaBox.height - margins.top - margins.bottom;
    return cropWidth > 0 && cropHeight > 0 && resolvedPages.value.length > 0;
});

const rangePages = computed(() => {
    const parsed = parsePageRangeInput(rangeInput.value, props.totalPages);
    if (!parsed) {
        return null;
    }
    const pages: number[] = [];
    for (let page = parsed.startPage; page <= parsed.endPage; page += 1) {
        pages.push(page);
    }
    return pages;
});

const resolvedPages = computed((): number[] => {
    switch (scope.value) {
        case 'all': return Array.from({ length: props.totalPages }, (_, i) => i + 1);
        case 'current': return [props.currentPage];
        case 'even': return Array.from({ length: props.totalPages }, (_, i) => i + 1).filter(p => p % 2 === 0);
        case 'odd': return Array.from({ length: props.totalPages }, (_, i) => i + 1).filter(p => p % 2 !== 0);
        case 'range': return rangePages.value ?? [];
        case 'selected': return normalizedSelectedPages.value;
        default: return [];
    }
});

function handleApply() {
    if (!isValid.value) {
        return;
    }

    emit('apply', {
        margins: { ...margins },
        pages: resolvedPages.value,
    });
    open.value = false;
}

function handleRemoveCrop() {
    const pages = resolvedPages.value.length > 0
        ? resolvedPages.value
        : Array.from({ length: props.totalPages }, (_, i) => i + 1);
    emit('remove', { pages });
    open.value = false;
}

watch(open, (isOpen) => {
    if (!isOpen) {
        return;
    }
    margins.top = props.initialMargins.top;
    margins.bottom = props.initialMargins.bottom;
    margins.left = props.initialMargins.left;
    margins.right = props.initialMargins.right;
    scope.value = 'current';
    rangeInput.value = '';
});

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
