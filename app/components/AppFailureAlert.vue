<template>
    <UAlert
        color="error"
        :variant="variant"
        :icon="icon"
        :title="presentation.title"
        :description="formatFailurePresentationDescription(presentation)"
        :actions="actions"
    />
</template>

<script setup lang="ts">
import type {FailurePresentation} from '@app/composables/useFailureToast';
import {
    copyFailurePresentation,
    formatFailurePresentationDescription,
} from '@app/composables/useFailureToast';

const {
    presentation,
    icon = 'i-ph-warning',
    variant = 'soft',
} = defineProps<{
    presentation: FailurePresentation;
    icon?: string;
    variant?: 'soft' | 'subtle' | 'outline' | 'solid'
}>();

const actions = computed(() => [
    {
        label: 'Copy details',
        onClick: () => {
            void copyFailurePresentation(presentation);
        },
    },
    ...(presentation.actions ?? []),
]);
</script>
