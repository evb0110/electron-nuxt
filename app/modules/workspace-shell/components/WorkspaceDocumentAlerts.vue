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
        v-if="canUseDjvu && isDjvuMode && djvuError"
        color="error"
        variant="soft"
        class="mx-3 mt-2"
        data-testid="workspace-document-djvu-error"
        :description="String(djvuError)"
        :ui="{ title: 'sr-only' }"
    />

    <DjvuBanner
        v-if="canUseDjvu && (isDjvuMode || djvuPendingOpen)"
        :visible="djvuShowBanner || djvuPendingOpen"
        :is-loading-pages="djvuIsLoadingPages"
        :loading-current="djvuLoadingCurrent"
        :loading-total="djvuLoadingTotal"
        @convert="handleConvert"
        @dismiss="handleDismiss"
    />
</template>

<script setup lang="ts">
import { DjvuBanner } from '@app/modules/djvu-viewer/public/component-exports/djvuBanner';

defineProps<{
    pdfError: unknown;
    canUseDjvu: boolean;
    isDjvuMode: boolean;
    djvuPendingOpen: boolean;
    djvuError: unknown;
    djvuShowBanner: boolean;
    djvuIsLoadingPages: boolean;
    djvuLoadingCurrent: number;
    djvuLoadingTotal: number;
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
