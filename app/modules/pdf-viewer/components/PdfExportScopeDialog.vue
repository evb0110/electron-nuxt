<template>
    <UModal
        v-model:open="open"
        :title="dialogTitle"
        :ui="{ footer: 'justify-end gap-2' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('export.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <URadioGroup
                    v-model="scope"
                    :legend="t('export.scopeLabel')"
                    :items="scopeOptions"
                    :ui="radioGroupUi"
                />

                <UFormField
                    v-if="scope === 'range'"
                    :error="rangeError"
                    class="mt-1"
                    :ui="rangeFieldUi"
                >
                    <UInput
                        v-model="rangeInput"
                        :placeholder="t('export.rangePlaceholder')"
                        @blur="rangeTouched = true"
                    />
                </UFormField>

                <p class="m-0 mt-1 text-xs text-muted">
                    {{ exportSummary }}
                </p>
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="outline"
                :label="t('common.cancel')"
                @click="open = false"
            />
            <UButton
                color="primary"
                :label="dialogActionLabel"
                :disabled="totalPages <= 0"
                @click="handleSubmit"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">

import { parsePageRangeInput } from '@app/utils/pdfPageLabels';
import { expandPageRange } from '@app/utils/pdfPageSelection';
import { usePdfPageScopeSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfPageScopeSelection';

type TExportMode = 'images' | 'multipage-tiff';

const open = defineModel<boolean>('open', { required: true });

const {
    currentPage,
    mode,
    selectedPages,
    totalPages,
} = defineProps<{
    mode: TExportMode;
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
}>();

const emit = defineEmits<{submit: [payload: { pageNumbers?: number[] }];}>();

const { t } = useTypedI18n();

const radioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'mb-0.5 text-xs text-muted font-normal',
    item: 'items-center',
    label: 'font-normal',
} as const;

const rangeFieldUi = { error: 'mt-1 text-xs' } as const;

const dialogTitle = computed(() => (
    mode === 'images'
        ? t('dialogs.exportImages')
        : t('dialogs.exportMultiPageTiff')
));

const dialogActionLabel = computed(() => (
    mode === 'images'
        ? t('export.exportImagesAction')
        : t('export.exportTiffAction')
));

const rangePages = computed(() => {
    return expandPageRange(parsePageRangeInput(rangeInput.value, totalPages));
});

const {
    scope,
    rangeInput,
    rangeTouched,
    normalizedSelectedPages,
    resetScopeForOpen,
    resolveScopedPageNumbers,
} = usePdfPageScopeSelection({
    totalPages: () => totalPages,
    currentPage: () => currentPage,
    selectedPages: () => selectedPages,
    resolveRangePages: () => rangePages.value,
});

const scopeOptions = computed(() => {
    const options = [
        {
            value: 'all',
            label: t('export.scopeAll', { count: totalPages }),
        },
        {
            value: 'current',
            label: t('export.scopeCurrent', { page: currentPage }),
        },
        {
            value: 'range',
            label: t('export.scopeRange'),
        },
    ];

    if (normalizedSelectedPages.value.length > 0) {
        options.push({
            value: 'selected',
            label: t('export.scopeSelected', { count: normalizedSelectedPages.value.length }),
        });
    }

    return options;
});

const rangeError = computed(() => (
    scope.value === 'range'
    && rangeTouched.value
    && rangeInput.value.trim().length > 0
    && rangePages.value === null
        ? t('export.invalidRange')
        : false
));

const exportSummary = computed(() => {
    if (scope.value === 'all') {
        return t('export.summaryAll', { count: totalPages });
    }
    if (scope.value === 'current') {
        return t('export.summaryCurrent', { page: currentPage });
    }
    if (scope.value === 'selected') {
        return t('export.summarySelected', { count: normalizedSelectedPages.value.length });
    }
    if (rangePages.value) {
        return t('export.summaryRange', { count: rangePages.value.length });
    }
    return t('export.summaryRangeHint');
});

function handleSubmit() {
    if (totalPages <= 0) {
        return;
    }

    if (scope.value === 'range' && !rangePages.value) {
        rangeTouched.value = true;
        return;
    }

    const pageNumbers = resolveScopedPageNumbers();
    if (pageNumbers === null) {
        rangeTouched.value = true;
        return;
    }

    emit('submit', {...(pageNumbers !== undefined ? { pageNumbers } : {})});
    open.value = false;
}

watch(open, (isOpen) => {
    if (!isOpen) {
        return;
    }

    resetScopeForOpen();
});
</script>
