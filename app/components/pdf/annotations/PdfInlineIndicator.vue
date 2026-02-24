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
    border: 1px solid rgb(150 129 33 / 0.68);
    border-radius: 4px;
    background: linear-gradient(180deg, rgb(252 246 198 / 0.62) 0%, rgb(239 225 135 / 0.58) 100%);
    box-shadow:
        0 1px 3px rgb(0 0 0 / 0.14),
        inset 0 0 0 1px rgb(255 255 255 / 0.35);
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
    background-color: rgb(110 96 23 / 0.84);
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
    border-color: color-mix(in oklab, var(--ui-primary, #3b82f6) 44%, rgb(165 145 41));
    box-shadow:
        0 0 0 1px color-mix(in oklab, var(--ui-primary, #3b82f6) 22%, transparent),
        0 1px 4px rgb(0 0 0 / 0.2),
        inset 0 0 0 1px rgb(255 255 255 / 0.62);
    opacity: 0.96;
}

.pdf-inline-indicator-badge {
    position: absolute;
    right: -5px;
    top: -5px;
    min-width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 1.5px solid rgb(120 80 10 / 0.75);
    background: linear-gradient(180deg, #fff 0%, #fde68a 100%);
    color: rgb(60 40 5);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 6.5px;
    font-weight: 700;
    line-height: 1;
    padding: 0 3px;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.22);
    pointer-events: none;
}
</style>
