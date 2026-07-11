<template>
    <template v-for="(segment, index) in segments" :key="index">
        <code v-if="segment.kind === 'code'" class="agent-assistant-message-inline-code">{{ segment.text }}</code>
        <strong v-else-if="segment.kind === 'strong'" class="agent-assistant-message-strong">{{ segment.text }}</strong>
        <em v-else-if="segment.kind === 'emphasis'" class="agent-assistant-message-emphasis">{{ segment.text }}</em>
        <a
            v-else-if="segment.kind === 'link'"
            class="agent-assistant-message-link"
            :href="segment.href"
            target="_blank"
            rel="noopener noreferrer"
        >{{ segment.text }}</a>
        <span v-else>{{ segment.text }}</span>
    </template>
</template>

<script setup lang="ts">
import type { TAssistantMessageSegment } from '@app/modules/agent-panel/utils/formatAssistantMessage';

defineProps<{segments: TAssistantMessageSegment[]}>();
</script>
