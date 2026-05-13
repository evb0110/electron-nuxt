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
            @click="onDeletePages"
        >
            <UIcon name="i-ph-trash" class="pdf-context-menu__icon" />
            {{ t('pageOps.deletePages') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onExtractPages"
        >
            <UIcon name="i-ph-export" class="pdf-context-menu__icon" style="transform: scaleX(-1)" />
            {{ t('pageOps.extractPages') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onExportPages"
        >
            <UIcon name="i-ph-export" class="pdf-context-menu__icon" />
            {{ t('pageOps.exportPages') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onRotateCw"
        >
            <UIcon name="i-ph-arrow-clockwise" class="pdf-context-menu__icon" />
            {{ t('pageOps.rotateCw') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onRotateCcw"
        >
            <UIcon name="i-ph-arrow-counter-clockwise" class="pdf-context-menu__icon" />
            {{ t('pageOps.rotateCcw') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onInsertBefore"
        >
            <UIcon name="i-ph-file-plus" class="pdf-context-menu__icon" />
            {{ t('pageOps.insertBefore') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="isOperationInProgress || isDjvuMode"
            @click="onInsertAfter"
        >
            <UIcon name="i-ph-file-plus" class="pdf-context-menu__icon" />
            {{ t('pageOps.insertAfter') }}
        </button>

        <div class="pdf-context-menu__divider" />

        <button
            type="button"
            class="pdf-context-menu__action"
            @click="onSelectAll"
        >
            {{ t('pageOps.selectAll') }}
        </button>

        <button
            type="button"
            class="pdf-context-menu__action"
            @click="onInvertSelection"
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

function onDeletePages() {
    emit('delete-pages');
}

function onExtractPages() {
    emit('extract-pages');
}

function onExportPages() {
    emit('export-pages');
}

function onRotateCw() {
    emit('rotate-cw');
}

function onRotateCcw() {
    emit('rotate-ccw');
}

function onInsertBefore() {
    emit('insert-before');
}

function onInsertAfter() {
    emit('insert-after');
}

function onSelectAll() {
    emit('select-all');
}

function onInvertSelection() {
    emit('invert-selection');
}
</script>
