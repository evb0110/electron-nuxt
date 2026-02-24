<template>
    <UTooltip :text="preview" :delay-duration="200">
        <button
            type="button"
            class="pdf-comment-marker-button"
            :class="{
                'is-active': isActive,
                'is-cluster': clustered.length > 1,
            }"
            :aria-label="labelText"
            :data-stable-key="annotation.stableKey"
            :data-comment-count="clustered.length > 1 ? String(clustered.length) : undefined"
            @click.stop="handleClick"
            @contextmenu.prevent="handleContextMenu"
        >
            <span class="pdf-comment-marker-icon" />
            <span
                v-if="clustered.length > 1"
                class="pdf-comment-marker-badge"
            >
                {{ clustered.length }}
            </span>
        </button>
    </UTooltip>
</template>

<script setup lang="ts">
import type { IAnnotationCommentSummary } from '@app/composables/pdf/annotations/types';

const props = defineProps<{
    annotation: IAnnotationCommentSummary;
    clustered: IAnnotationCommentSummary[];
    isActive: boolean;
    preview: string;
    labelText: string;
    leftPercent: number;
    topPercent: number;
}>();

const emit = defineEmits<{
    openNote: [comment: IAnnotationCommentSummary];
    contextMenu: [comment: IAnnotationCommentSummary, event: MouseEvent];
}>();

function handleClick() {
    emit('openNote', props.annotation);
}

function handleContextMenu(event: MouseEvent) {
    emit('contextMenu', props.annotation, event);
}
</script>

<style scoped>
.pdf-comment-marker-button {
    position: absolute;
    left: calc(v-bind('leftPercent + "%"'));
    top: calc(v-bind('topPercent + "%"'));
    width: 14px;
    height: 14px;
    border: 1px solid rgb(145 120 24 / 0.78);
    border-radius: 3px;
    transform: translate(-50%, -50%);
    background: linear-gradient(180deg, rgb(252 246 198 / 0.82) 0%, rgb(238 221 120 / 0.78) 100%);
    box-shadow:
        0 1px 3px rgb(0 0 0 / 0.16),
        inset 0 0 0 1px rgb(255 255 255 / 0.46);
    cursor: pointer;
    pointer-events: auto;
    opacity: 0.88;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.pdf-comment-marker-button:hover {
    transform: translate(-50%, -50%) scale(1.04);
    opacity: 0.96;
}

.pdf-comment-marker-button.is-active {
    border-color: color-mix(in oklab, var(--ui-primary, #3b82f6) 44%, rgb(165 145 41));
    box-shadow:
        0 0 0 1.5px color-mix(in oklab, var(--ui-primary, #3b82f6) 22%, transparent),
        0 1px 4px rgb(0 0 0 / 0.2),
        inset 0 0 0 1px rgb(255 255 255 / 0.62);
    opacity: 0.9;
}

.pdf-comment-marker-icon {
    position: absolute;
    inset: 2px;
    background-color: rgb(110 96 23 / 0.84);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 5V5z'/%3E%3C/svg%3E");
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
}

.pdf-comment-marker-badge {
    position: absolute;
    right: -6px;
    top: -6px;
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

.pdf-comment-marker-button.is-cluster:hover .pdf-comment-marker-badge,
.pdf-comment-marker-button.is-cluster.is-active .pdf-comment-marker-badge {
    border-color: rgb(100 65 5 / 0.9);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.32);
}
</style>
