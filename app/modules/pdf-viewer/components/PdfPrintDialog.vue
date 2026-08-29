<template>
    <UModal
        v-model:open="open"
        :title="t('print.title')"
        :ui="dialogUi"
    >
        <template #description>
            <span class="sr-only">
                {{ t('print.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-2">
                    <URadioGroup
                        v-model="scope"
                        :legend="t('print.scopeLabel')"
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
                            :placeholder="t('print.rangePlaceholder')"
                            @blur="rangeTouched = true"
                        />
                    </UFormField>
                </div>

                <div
                    v-if="supportsAdvancedPrintOptions !== false"
                    class="grid gap-4 sm:grid-cols-3"
                >
                    <!--
                        Two of the three tracks go to the layout column: its
                        option names run to 289px in Dutch and 288px in Russian,
                        while no locale's orientation name passes 101px.
                    -->
                    <div class="flex min-w-0 flex-col gap-2 sm:col-span-2">
                        <p class="m-0 text-xs text-muted">
                            {{ t('print.layoutLabel') }}
                        </p>
                        <div class="grid gap-2">
                            <!--
                                The option text goes in the default slot, not `label`: the
                                button theme's label slot is `truncate`, whose `nowrap` makes
                                the button's min-content width the whole option name. A grid
                                item that wide escapes its `1fr` column and paints over the
                                next one, which is what the longer non-English option names do.
                            -->
                            <UButton
                                v-for="option in layoutOptions"
                                :key="option.value"
                                :color="viewMode === option.value ? 'primary' : 'neutral'"
                                :variant="viewMode === option.value ? 'soft' : 'outline'"
                                :aria-pressed="viewMode === option.value"
                                :class="optionButtonClass"
                                @click="viewMode = option.value"
                            >
                                {{ option.label }}
                            </UButton>
                        </div>
                    </div>

                    <div class="flex min-w-0 flex-col gap-2">
                        <p class="m-0 text-xs text-muted">
                            {{ t('print.orientationLabel') }}
                        </p>
                        <div class="grid gap-2">
                            <UButton
                                v-for="option in orientationOptions"
                                :key="option.value"
                                :color="orientation === option.value ? 'primary' : 'neutral'"
                                :variant="orientation === option.value ? 'soft' : 'outline'"
                                :aria-pressed="orientation === option.value"
                                :class="optionButtonClass"
                                @click="orientation = option.value"
                            >
                                {{ option.label }}
                            </UButton>
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
                variant="outline"
                :label="t('common.cancel')"
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
import {
    parsePrintPageRangeInput,
    type TPrintOrientation,
} from '@app/utils/pdfPrintShared';
import { usePdfPageScopeSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfPageScopeSelection';

const open = defineModel<boolean>('open', { required: true });

const {
    currentPage,
    defaultViewMode,
    isPreparing,
    selectedPages,
    totalPages,
    supportsAdvancedPrintOptions,
} = defineProps<{
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
    defaultViewMode: TPdfViewMode;
    isPreparing: boolean;
    status: string | null;
    error: string | null;
    supportsAdvancedPrintOptions?: boolean;
}>();

const emit = defineEmits<{submit: [payload: {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}];}>();

const { t } = useTypedI18n();

const radioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'mb-0.5 text-xs text-muted font-normal',
    item: 'items-center',
    label: 'font-normal',
} as const;

const rangeFieldUi = { error: 'mt-1 text-xs' } as const;

// The default modal is `max-w-lg`, which leaves each option column ~209px and
// wraps the longest layout names. `max-w-xl` plus the 2:1 column split gives the
// layout column ~327px, enough for every locale's option names on one line.
const dialogUi = {
    content: 'max-w-xl',
    footer: 'justify-end gap-2',
} as const;

// `min-w-0` lets the button shrink to its column and `text-start` overrides the
// centring a `<button>` applies to the extra lines a wrapped name produces.
// `wrap-anywhere` rather than `break-words`: only `overflow-wrap: anywhere`
// shrinks the text's min-content width, so a locale that names an option with
// one unbreakable compound word wraps it instead of spilling past the button.
const optionButtonClass = 'min-w-0 justify-start wrap-anywhere text-start';

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

const scopeOptions = computed(() => {
    const options = [
        {
            value: 'all',
            label: t('print.scopeAll', { count: totalPages }),
        },
        {
            value: 'current',
            label: t('print.scopeCurrent', { page: currentPage }),
        },
    ];

    if (normalizedSelectedPages.value.length > 0) {
        options.push({
            value: 'selected',
            label: t('print.scopeSelected', { count: normalizedSelectedPages.value.length }),
        });
    }

    options.push({
        value: 'range',
        label: t('print.scopeRange'),
    });

    return options;
});

const rangeError = computed(() => (
    scope.value === 'range'
    && rangeTouched.value
    && rangeInput.value.trim().length > 0
    && rangePages.value === null
        ? t('print.invalidRange')
        : false
));

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
    const pageNumbers = resolveScopedPageNumbers();
    if (!canSubmit.value || pageNumbers === null) {
        rangeTouched.value = true;
        return;
    }

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
    viewMode.value = supportsAdvancedPrintOptions === false ? 'single' : defaultViewMode;
    orientation.value = 'auto';
});
</script>
