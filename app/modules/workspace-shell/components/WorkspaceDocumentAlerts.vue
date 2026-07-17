<template>
    <UAlert
        v-if="pdfError"
        color="error"
        variant="soft"
        class="mx-3 mt-2"
        data-testid="workspace-document-pdf-error"
        :title="t('errors.file.open')"
        :description="String(pdfError)"
        :ui="{ title: 'sr-only' }"
    />

    <UAlert
        v-if="showDjvuConversionUi && djvuError"
        color="error"
        variant="soft"
        class="mx-3 mt-2"
        data-testid="workspace-document-djvu-error"
        :description="String(djvuError)"
        :ui="{ title: 'sr-only' }"
    />

    <Transition name="document-status">
        <DjvuBanner
            v-if="showDjvuBanner"
            @convert="handleConvert"
            @dismiss="handleDismiss"
        />
    </Transition>
</template>

<script setup lang="ts">
import { DjvuBanner } from '@app/modules/djvu-viewer/public/component-exports/djvuBanner';

defineProps<{
    pdfError: unknown;
    showDjvuConversionUi: boolean;
    djvuError: unknown;
    showDjvuBanner: boolean;
}>();

const emit = defineEmits<{
    convert: [];
    dismiss: [];
}>();

const { t } = useTypedI18n();

function handleConvert() {
    emit('convert');
}

function handleDismiss() {
    emit('dismiss');
}
</script>
