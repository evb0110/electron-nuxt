<template>
    <ToolbarButton
        v-if="isAvailable"
        icon="ph:sparkle"
        :active="isOpen"
        :tooltip="t('assistant.toggle')"
        @click="toggle"
    />
</template>

<script setup lang="ts">
import ToolbarButton from '@app/components/ToolbarButton.vue';
import { useAssistantPanel } from '@app/composables/useAssistantPanel';

const { t } = useTypedI18n();
const {
    isOpen,
    isAvailable,
    toggle,
} = useAssistantPanel();
</script>
