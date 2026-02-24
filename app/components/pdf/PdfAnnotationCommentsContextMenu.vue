<template>
    <PdfContextMenuBase
        class="notes-context-menu"
        :visible="visible"
        :style="menuStyle"
        variant="panel"
        min-width="10.5rem"
        :z-index="1400"
    >
        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="!comment"
            @click="emit('open')"
        >
            {{ t('annotations.openNote') }}
        </button>
        <button
            type="button"
            class="pdf-context-menu__action"
            :disabled="!comment"
            @click="emit('copy')"
        >
            {{ t('annotations.copyText') }}
        </button>
        <button
            type="button"
            class="pdf-context-menu__action pdf-context-menu__action--danger"
            :disabled="!comment"
            @click="emit('delete')"
        >
            {{ t('annotations.delete') }}
        </button>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface IProps {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'open'): void;
    (e: 'copy'): void;
    (e: 'delete'): void;
}>();

const { t } = useTypedI18n();

const menuStyle = computed(() => ({
    left: `${props.x}px`,
    top: `${props.y}px`,
}));
</script>
