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

<style scoped>
/* This component renders a fragment, so the panel's scoped stylesheet cannot
   reach these nodes. Its own styles have to live here. */
.agent-assistant-message-strong {
    color: inherit;
    font-weight: var(--app-font-weight-semibold);
}

.agent-assistant-message-emphasis {
    color: inherit;
    font-style: italic;
}

.agent-assistant-message-link {
    color: var(--ui-primary);
    text-decoration: underline;
    text-underline-offset: 0.14em;
    overflow-wrap: anywhere;
}

.agent-assistant-message-inline-code {
    padding: 0 var(--app-space-sm);
    border: 1px solid color-mix(in oklab, var(--ui-border) 72%, transparent);
    border-radius: var(--app-radius-sm);
    background: var(--ui-bg-muted);
    color: var(--ui-text);
    font-family: var(--app-font-mono);
    font-size: var(--app-text-scale-inline-meta);
}

.agent-assistant-message.is-system .agent-assistant-message-link {
    color: var(--ui-error);
}

.agent-assistant-message.is-system .agent-assistant-message-inline-code {
    border-color: color-mix(in oklab, var(--ui-error) 28%, transparent);
    background: color-mix(in oklab, var(--ui-error) 8%, var(--ui-bg) 92%);
    color: var(--ui-error);
}
</style>
