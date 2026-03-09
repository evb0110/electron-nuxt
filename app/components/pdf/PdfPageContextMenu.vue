<template>
    <PdfContextMenuBase
        class="page-context-menu"
        :visible="menu.visible"
        :style="style"
        variant="grid"
        min-width="208px"
    >
        <p class="pdf-context-menu__section-title">
            {{ t('pageOps.pagesSelected', menu.pages.length) }}
        </p>

        <button
            type="button"
            class="pdf-context-menu__action pdf-context-menu__action--danger"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('delete-pages')"
        >
            <UIcon name="i-lucide-trash-2" class="pdf-context-menu__icon" />
            {{ t('pageOps.deletePages') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('extract-pages')"
        >
            <UIcon name="i-lucide-file-output" class="pdf-context-menu__icon" style="transform: scaleX(-1)" />
            {{ t('pageOps.extractPages') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('export-pages')"
        >
            <UIcon name="i-lucide-file-output" class="pdf-context-menu__icon" />
            {{ t('pageOps.exportPages') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('rotate-cw')"
        >
            <UIcon name="i-lucide-rotate-cw" class="pdf-context-menu__icon" />
            {{ t('pageOps.rotateCw') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('rotate-ccw')"
        >
            <UIcon name="i-lucide-rotate-ccw" class="pdf-context-menu__icon" />
            {{ t('pageOps.rotateCcw') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('insert-before')"
        >
            <UIcon name="i-lucide-file-plus" class="pdf-context-menu__icon" />
            {{ t('pageOps.insertBefore') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="emit('insert-after')"
        >
            <UIcon name="i-lucide-file-plus" class="pdf-context-menu__icon" />
            {{ t('pageOps.insertAfter') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            @click="emit('select-all')"
        >
            {{ t('pageOps.selectAll') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            @click="emit('invert-selection')"
        >
            {{ t('pageOps.invertSelection') }}
        </button>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import PdfContextMenuBase from '@app/components/pdf/PdfContextMenuBase.vue';

interface IPageContextMenuState {
    visible: boolean;
    pages: number[];
}

defineProps<{
    menu: IPageContextMenuState;
    style: Record<string, string>;
    isOperationInProgress: boolean;
    isDjvuMode?: boolean;
}>();

const emit = defineEmits<{
    'delete-pages': [];
    'extract-pages': [];
    'export-pages': [];
    'rotate-cw': [];
    'rotate-ccw': [];
    'insert-before': [];
    'insert-after': [];
    'select-all': [];
    'invert-selection': [];
}>();

const { t } = useTypedI18n();
</script>
