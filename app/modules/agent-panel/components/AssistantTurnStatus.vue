<template>
    <div v-if="active" class="agent-assistant-turn-progress">
        <UIcon name="i-ph-circle-notch" class="agent-assistant-working-icon is-spinning" />
        <span>{{ statusText }}</span>
    </div>
    <details v-if="reasoning" class="agent-assistant-reasoning" open>
        <summary>Thinking…</summary>
        <pre class="app-scrollbar app-scroll-region--balanced">{{ reasoning }}</pre>
    </details>
    <div
        v-for="tool in tools"
        :key="tool.toolId"
        class="agent-assistant-tool-activity"
    >
        <UIcon :name="tool.phase === 'running' ? 'i-ph-circle-notch' : 'i-ph-check-circle'" />
        <span>{{ tool.name }} — {{ tool.phase }}</span>
    </div>
    <span v-if="usage" class="agent-assistant-tool-activity">
        {{ usage.inputTokens }} input · {{ usage.outputTokens }} output tokens
    </span>
    <p v-if="stalled" class="agent-assistant-turn-error">
        No signal from the assistant. It may be stuck; stop the turn or retry.
    </p>
    <UButton
        v-if="canRetry"
        label="Retry"
        icon="i-ph-arrow-clockwise"
        color="neutral"
        variant="outline"
        size="xs"
        @click="$emit('retry')"
    />
</template>

<script setup lang="ts">
import type { IAgentAssistantTurnState } from '@contracts/agent';

defineProps<{
    active: boolean;
    canRetry: boolean;
    reasoning: string;
    stalled: boolean;
    statusText: string;
    tools: IAgentAssistantTurnState['toolActivity'];
    usage: IAgentAssistantTurnState['usage'];
}>();

defineEmits<{retry: []}>();
</script>

<style scoped>
/* This component renders a fragment, so the panel's scoped stylesheet cannot
   reach these nodes. Its own styles have to live here. */
.agent-assistant-turn-progress {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: var(--app-space-xl);
    padding: var(--app-space-xl) var(--app-space-7xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg);
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-kicker);
}

.agent-assistant-working-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 auto;
}

.is-spinning {
    animation: agent-assistant-turn-spin 1s linear infinite;
}

.agent-assistant-reasoning,
.agent-assistant-tool-activity {
    margin: 0.4rem 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-meta);
}

.agent-assistant-reasoning pre {
    margin: 0.35rem 0 0;
    max-height: var(--app-assistant-message-max-height);
    overflow: auto;
    white-space: pre-wrap;
    font: inherit;
}

.agent-assistant-tool-activity {
    display: flex;
    align-items: center;
    gap: 0.35rem;
}

.agent-assistant-turn-error {
    margin: 0.4rem 0;
    color: var(--ui-error);
    font-size: var(--app-text-size-body-sm);
    line-height: 1.45;
}

@keyframes agent-assistant-turn-spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
