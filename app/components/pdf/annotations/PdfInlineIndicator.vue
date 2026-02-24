<template>
    <UTooltip :text="preview" :delay-duration="200">
        <button
            type="button"
            class="pdf-inline-indicator"
            :class="{
                'is-active': isActive,
                'is-cluster': commentCount > 1,
            }"
            :aria-label="ariaLabel"
            :data-stable-key="stableKey"
            :data-comment-count="commentCount > 1 ? String(commentCount) : undefined"
            @click.stop="emit('openNote')"
            @contextmenu.prevent="emit('contextMenu', $event)"
        >
            <span class="pdf-inline-indicator-dot" />
            <span
                v-if="commentCount > 1"
                class="pdf-inline-indicator-badge"
            >
                {{ commentCount }}
            </span>
        </button>
    </UTooltip>
</template>

<script setup lang="ts">
defineProps<{
    stableKey: string;
    preview: string;
    ariaLabel: string;
    isActive: boolean;
    commentCount: number;
}>();

const emit = defineEmits<{
    openNote: [];
    contextMenu: [event: MouseEvent];
}>();
</script>

<style scoped>
.pdf-inline-indicator {
    position: absolute;
    right: 0;
    top: 0;
    width: 11px;
    height: 11px;
    border: 1px solid var(--app-pdf-comment-marker-border);
    border-radius: 4px;
    background: var(--app-pdf-comment-marker-bg);
    box-shadow: var(--app-pdf-comment-marker-shadow);
    cursor: pointer;
    z-index: 10;
    pointer-events: auto;
    padding: 0;
    opacity: 0.7;
    transform: translate(132%, -132%);
}

.pdf-inline-indicator-dot {
    position: absolute;
    inset: 2px;
    background-color: var(--app-pdf-comment-marker-icon);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 5V5z'/%3E%3C/svg%3E");
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
}

.pdf-inline-indicator:hover {
    transform: translate(132%, -132%) scale(1.05);
    opacity: 0.9;
}

.pdf-inline-indicator.is-active {
    border-color: var(--app-pdf-comment-marker-active-border);
    box-shadow:
        0 0 0 1px var(--app-pdf-comment-marker-active-ring),
        var(--app-pdf-comment-marker-active-shadow);
    opacity: 0.96;
}

.pdf-inline-indicator-badge {
    position: absolute;
    right: -5px;
    top: -5px;
    min-width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 1.5px solid var(--app-pdf-comment-marker-badge-border);
    background: var(--app-pdf-comment-marker-badge-bg);
    color: var(--app-pdf-comment-marker-badge-fg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 6.5px;
    font-weight: 700;
    line-height: 1;
    padding: 0 3px;
    font-variant-numeric: tabular-nums;
    box-shadow: var(--app-pdf-comment-marker-badge-shadow);
    pointer-events: none;
}
</style>
