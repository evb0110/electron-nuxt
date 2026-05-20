<template>
    <UModal
        v-model:open="open"
        :title="t('print.title')"
        :ui="{ footer: 'justify-end gap-2' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('print.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-2">
                    <p class="m-0 mb-0.5 text-xs text-muted">
                        {{ t('print.scopeLabel') }}
                    </p>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input
                            v-model="scope"
                            type="radio"
                            value="all"
                        >
                        <span>{{ t('print.scopeAll', { count: totalPages }) }}</span>
                    </label>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input
                            v-model="scope"
                            type="radio"
                            value="current"
                        >
                        <span>{{ t('print.scopeCurrent', { page: currentPage }) }}</span>
                    </label>

                    <label
                        v-if="normalizedSelectedPages.length > 0"
                        class="flex items-center gap-2 text-sm text-default"
                    >
                        <input
                            v-model="scope"
                            type="radio"
                            value="selected"
                        >
                        <span>{{ t('print.scopeSelected', { count: normalizedSelectedPages.length }) }}</span>
                    </label>

                    <label class="flex items-center gap-2 text-sm text-default">
                        <input
                            v-model="scope"
                            type="radio"
                            value="range"
                        >
                        <span>{{ t('print.scopeRange') }}</span>
                    </label>

                    <UInput
                        v-if="scope === 'range'"
                        v-model="rangeInput"
                        :placeholder="t('print.rangePlaceholder')"
                        class="mt-1"
                        @blur="rangeTouched = true"
                    />

                    <p
                        v-if="scope === 'range' && rangeTouched && rangeInput.trim() && rangePages === null"
                        class="m-0 text-xs text-error"
                    >
                        {{ t('print.invalidRange') }}
                    </p>
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="flex flex-col gap-2">
                        <p class="m-0 text-xs text-muted">
                            {{ t('print.layoutLabel') }}
                        </p>
                        <div class="grid gap-2">
                            <UButton
                                v-for="option in layoutOptions"
                                :key="option.value"
                                :label="option.label"
                                :color="viewMode === option.value ? 'primary' : 'neutral'"
                                :variant="viewMode === option.value ? 'soft' : 'outline'"
                                class="justify-start"
                                @click="viewMode = option.value"
                            />
                        </div>
                    </div>

                    <div class="flex flex-col gap-2">
                        <p class="m-0 text-xs text-muted">
                            {{ t('print.orientationLabel') }}
                        </p>
                        <div class="grid gap-2">
                            <UButton
                                v-for="option in orientationOptions"
                                :key="option.value"
                                :label="option.label"
                                :color="orientation === option.value ? 'primary' : 'neutral'"
                                :variant="orientation === option.value ? 'soft' : 'outline'"
                                class="justify-start"
                                @click="orientation = option.value"
                            />
                        </div>
                    </div>
                </div>

                <p class="m-0 text-xs text-muted">
                    {{ printSummary }}
                </p>

                <p class="m-0 text-xs text-muted">
                    {{ t('print.systemDialogHint') }}
                </p>

                <p class="m-0 min-h-5 text-xs text-muted">
                    {{ status || '\u00A0' }}
                </p>

                <UAlert
                    v-if="error"
                    color="error"
                    variant="soft"
                    icon="i-ph-warning-circle"
                    :description="error"
                />
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="ghost"
                :label="t('common.cancel')"
                :disabled="isPreparing"
                @click="open = false"
            />
            <UButton
                color="primary"
                class="justify-center"
                :disabled="!canSubmit"
                @click="handleSubmit"
            >
                <span class="inline-flex items-center justify-center gap-2">
                    <UIcon
                        :name="isPreparing ? 'i-ph-circle-notch' : 'i-ph-printer'"
                        :class="[
                            'size-4 shrink-0',
                            isPreparing ? 'animate-spin' : '',
                        ]"
                        aria-hidden="true"
                    />
                    <span>{{ t('print.action') }}</span>
                </span>
            </UButton>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type { TPdfViewMode } from '@contracts/shared';
import type { TPrintOrientation } from '@app/utils/pdfPrint';
import { parsePrintPageRangeInput } from '@app/utils/pdfPrint';
import { usePdfPageScopeSelection } from '@app/composables/pdf/usePdfPageScopeSelection';

const open = defineModel<boolean>('open', { required: true });

const {
    currentPage,
    defaultViewMode,
    isPreparing,
    selectedPages,
    totalPages,
} = defineProps<{
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
    defaultViewMode: TPdfViewMode;
    isPreparing: boolean;
    status: string | null;
    error: string | null;
}>();

const emit = defineEmits<{submit: [payload: {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}];}>();

const { t } = useTypedI18n();

const viewMode = ref<TPdfViewMode>('single');
const orientation = ref<TPrintOrientation>('auto');

const rangePages = computed(() => parsePrintPageRangeInput(rangeInput.value, totalPages));
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

const printPageCount = computed(() => {
    if (scope.value === 'all') {
        return totalPages;
    }
    if (scope.value === 'current') {
        return totalPages > 0 ? 1 : 0;
    }
    if (scope.value === 'selected') {
        return normalizedSelectedPages.value.length;
    }
    return rangePages.value?.length ?? 0;
});

const layoutOptions = computed<Array<{
    value: TPdfViewMode;
    label: string;
}>>(() => [
    {
        value: 'single',
        label: t('print.layoutSingle'),
    },
    {
        value: 'facing',
        label: t('print.layoutFacing'),
    },
    {
        value: 'facing-first-single',
        label: t('print.layoutFacingFirstSingle'),
    },
]);

const orientationOptions = computed<Array<{
    value: TPrintOrientation;
    label: string;
}>>(() => [
    {
        value: 'auto',
        label: t('print.orientationAuto'),
    },
    {
        value: 'portrait',
        label: t('print.orientationPortrait'),
    },
    {
        value: 'landscape',
        label: t('print.orientationLandscape'),
    },
]);

const printSummary = computed(() => t('print.summary', {
    count: printPageCount.value,
    layout: layoutOptions.value.find(option => option.value === viewMode.value)?.label ?? t('print.layoutSingle'),
    orientation: orientationOptions.value.find(option => option.value === orientation.value)?.label ?? t('print.orientationAuto'),
}));

const canSubmit = computed(() => (
    totalPages > 0
    && !isPreparing
    && (scope.value !== 'range' || rangePages.value !== null)
));

function handleSubmit() {
    if (!canSubmit.value) {
        rangeTouched.value = true;
        return;
    }

    const pageNumbers = resolveScopedPageNumbers();
    emit('submit', {
        ...(pageNumbers !== undefined ? { pageNumbers } : {}),
        viewMode: viewMode.value,
        orientation: orientation.value,
    });
}

watch(open, (isOpen) => {
    if (!isOpen) {
        return;
    }

    resetScopeForOpen();
    viewMode.value = defaultViewMode;
    orientation.value = 'auto';
});
</script>
