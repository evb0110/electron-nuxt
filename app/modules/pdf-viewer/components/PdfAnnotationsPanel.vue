<template>
    <div class="notes-panel">
        <PdfAnnotationToolbar
            ref="toolbarRef"
            :tool="tool"
            :style-popover-open="stylePopoverOpen"
            @set-tool="setTool"
        />

        <div class="annotation-tool-options">
            <UCheckbox
                v-model="keepActiveModel"
                color="neutral"
                size="xs"
                :label="t('annotations.keepActive')"
            />
        </div>

        <div class="notes-panel-divider" />

        <div
            v-if="showStyleEditor"
            class="annotation-style-editor-cache"
            aria-hidden="true"
        >
            <PdfAnnotationStyleEditor
                :tool="tool"
                :settings="settings"
                @set-tool="setTool"
                @update-setting="updateSetting"
            />
        </div>

        <UPopover
            v-if="showStyleEditor"
            v-model:open="stylePopoverOpen"
            :reference="stylePopoverReference ?? undefined"
            :content="stylePopoverContent"
            portal="body"
        >
            <span class="style-popover-virtual-trigger" aria-hidden="true" />

            <template #content>
                <div
                    class="annotation-style-popover"
                    role="dialog"
                    :aria-label="stylePopoverLabel"
                >
                    <div class="annotation-style-popover-header">
                        <span class="annotation-style-popover-title">{{ stylePopoverLabel }}</span>
                        <button
                            type="button"
                            class="annotation-style-popover-close"
                            :aria-label="t('annotationProperties.close', undefined)"
                            @click="stylePopoverOpen = false"
                        >
                            <UIcon name="i-ph-x" class="annotation-style-popover-close-icon" />
                        </button>
                    </div>

                    <PdfAnnotationStyleEditor
                        :tool="tool"
                        :settings="settings"
                        @set-tool="setTool"
                        @update-setting="updateSetting"
                        @color-selected="stylePopoverOpen = false"
                    />
                </div>
            </template>
        </UPopover>

        <PdfAnnotationCommentsList
            :comments="comments"
            :status="commentsStatus"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="focusComment"
            @open-note="openNote"
            @delete-comment="deleteComment"
            @place-note="placeNote"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';
import PdfAnnotationStyleEditor from '@app/modules/pdf-viewer/components/PdfAnnotationStyleEditor.vue';
import PdfAnnotationToolbar from '@app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    commentsStatus: TAnnotationCommentsStatus;
    activeCommentStableKey?: string | null;
}

interface IPdfAnnotationToolbarExpose {getButtonEl(toolId: TAnnotationTool): HTMLElement | null;}

const { settings: appSettings } = useSettings();
const { t } = useTypedI18n();

const {
    keepActive,
    tool,
    settings,
    comments,
    commentsStatus,
    activeCommentStableKey: rawActiveCommentStableKey = null,
} = defineProps<IProps>();
const activeCommentStableKey = computed(() => rawActiveCommentStableKey ?? undefined);
const showStyleEditor = computed(() => isAuthoringAnnotationTool(tool));
const stylePopoverOpen = ref(false);
const toolbarRef = ref<IPdfAnnotationToolbarExpose | null>(null);
const stylePopoverReference = computed(() => toolbarRef.value?.getButtonEl(tool) ?? null);
const stylePopoverContent = {
    align: 'start' as const,
    side: 'bottom' as const,
    sideOffset: 4,
    collisionPadding: 12,
};
const colorSettingKeys = new Set<keyof IAnnotationSettings>([
    'highlightColor',
    'inkColor',
    'shapeColor',
    'squigglyColor',
    'strikethroughColor',
    'textColor',
    'underlineColor',
]);
let stylePopoverReopenTimer: ReturnType<typeof setTimeout> | null = null;

const toolLabel = computed(() => {
    switch (tool) {
        case 'draw':
            return t('annotations.draw');
        case 'text':
            return t('annotations.text');
        case 'highlight':
            return t('annotations.highlight');
        case 'underline':
            return t('annotations.underline');
        case 'strikethrough':
            return t('annotations.strikethrough');
        case 'squiggly':
            return t('annotations.squiggly');
        case 'rectangle':
            return t('annotations.rectangle');
        case 'circle':
            return t('annotations.circle');
        case 'line':
            return t('annotations.line');
        case 'arrow':
            return t('annotations.arrow');
        case 'select':
            return t('annotations.select');
        default:
            return t('annotations.annotations');
    }
});
const stylePopoverLabel = computed(() => `${toolLabel.value} ${t('annotations.style')}`);

const emit = defineEmits<{
    'set-tool': [tool: TAnnotationTool];
    'update:keep-active': [value: boolean];
    'update-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }];
    'focus-comment': [comment: IAnnotationCommentSummary];
    'open-note': [comment: IAnnotationCommentSummary];
    'delete-comment': [comment: IAnnotationCommentSummary];
    'place-note': [];
}>();

const keepActiveModel = computed({
    get() {
        return keepActive;
    },
    set(value: boolean | 'indeterminate') {
        if (value === 'indeterminate' || value === keepActive) {
            return;
        }
        emit('update:keep-active', value);
    },
});

function clearStylePopoverReopenTimer() {
    if (stylePopoverReopenTimer === null) {
        return;
    }
    clearTimeout(stylePopoverReopenTimer);
    stylePopoverReopenTimer = null;
}

watch(() => tool, async () => {
    clearStylePopoverReopenTimer();
    if (!showStyleEditor.value) {
        stylePopoverOpen.value = false;
        return;
    }

    await nextTick();
    stylePopoverOpen.value = true;
});

watch(() => commentsStatus, (status) => {
    if (status === 'loading') {
        clearStylePopoverReopenTimer();
        stylePopoverOpen.value = false;
    }
});

onBeforeUnmount(clearStylePopoverReopenTimer);

function setTool(nextTool: TAnnotationTool) {
    emit('set-tool', nextTool === tool ? 'none' : nextTool);
}

function updateSetting(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings];
}) {
    emit('update-setting', payload);
    if (showStyleEditor.value && !colorSettingKeys.has(payload.key)) {
        clearStylePopoverReopenTimer();
        stylePopoverReopenTimer = setTimeout(() => {
            stylePopoverReopenTimer = null;
            if (showStyleEditor.value) {
                stylePopoverOpen.value = true;
            }
        });
    }
}

function focusComment(comment: IAnnotationCommentSummary) {
    emit('focus-comment', comment);
}

function openNote(comment: IAnnotationCommentSummary) {
    emit('open-note', comment);
}

function deleteComment(comment: IAnnotationCommentSummary) {
    emit('delete-comment', comment);
}

function placeNote() {
    emit('place-note');
}
</script>

<style scoped>
.notes-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    min-height: 100%;
    height: 100%;
    overflow: visible;
    box-sizing: border-box;
    position: relative;
}

.notes-panel-divider {
    border-top: 1px solid var(--ui-border);
    margin: 0 -0.25rem;
}

.annotation-tool-options {
    display: flex;
    align-items: center;
    min-height: 1.5rem;
}

.style-popover-virtual-trigger {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
}

.annotation-style-editor-cache {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
}

.annotation-style-popover {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    position: relative;
    z-index: var(--app-pdf-annotation-style-popover-z-index);
    width: min(var(--app-pdf-annotation-style-popover-width), var(--app-overlay-viewport-width));
    max-width: var(--app-overlay-viewport-width);
    padding: 0.625rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.625rem;
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}

.annotation-style-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}

.annotation-style-popover-title {
    color: var(--ui-text-highlighted);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    line-height: 1.2;
    text-transform: uppercase;
}

.annotation-style-popover-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.annotation-style-popover-close:hover {
    border-color: var(--app-control-active-hover-border);
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.annotation-style-popover-close-icon {
    width: 0.75rem;
    height: 0.75rem;
}
</style>
