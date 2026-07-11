<template>
    <code :data-language="language"><span
        v-for="(token, index) in tokens"
        :key="index"
        :class="`agent-assistant-code-token is-${token.kind}`"
    >{{ token.text }}</span></code>
</template>

<script setup lang="ts">
import { highlightAssistantCode } from '@app/modules/agent-panel/utils/highlightAssistantCode';

const props = defineProps<{
    code: string;
    language: string | null;
}>();
const tokens = computed(() => highlightAssistantCode(props.code, props.language));
</script>
