<template>
    <div class="pdf-bookmark-item">
        <div
            class="pdf-bookmark-item-row"
            :class="{
                'is-active': isActive,
                'is-selected': isSelected,
                'is-editing': isEditing,
                'is-dragging': isDragging,
                'is-drop-before': isDropTargetBefore,
                'is-drop-after': isDropTargetAfter,
                'is-drop-child': isDropTargetChild,
                'is-style-range-start': isStyleRangeStart,
            }"
            tabindex="0"
            role="button"
            :draggable="treeContext.isEditMode.value && !isEditing"
            @click="handleClick"
            @keydown.enter.prevent="handleClick"
            @keydown.space.prevent="handleClick"
            @contextmenu.prevent.stop="openActionsFromPointer"
            @dragstart="handleDragStart"
            @dragover.prevent="handleDragOver"
            @drop.prevent="handleDrop"
            @dragend="handleDragEnd"
        >
            <span
                v-if="treeContext.isEditMode.value"
                class="pdf-bookmark-item-drag-handle"
                aria-hidden="true"
            >
                <UIcon
                    name="i-ph-dots-six-vertical"
                    class="size-3.5"
                />
            </span>
            <AppTooltip
                v-if="hasChildren"
                :text="isExpanded ? t('bookmarks.collapse') : t('bookmarks.expand')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmark-item-toggle"
                    :aria-label="isExpanded ? t('bookmarks.collapse') : t('bookmarks.expand')"
                    @click.stop="toggleExpand"
                >
                    <UIcon
                        :name="isExpanded ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                        class="size-4"
                    />
                </button>
            </AppTooltip>
            <span
                v-else
                class="pdf-bookmark-item-spacer"
            />

            <input
                v-if="isEditing"
                ref="titleInputRef"
                v-model="editingTitle"
                type="text"
                class="pdf-bookmark-item-input"
                @click.stop
                @keydown.enter.prevent="commitEdit"
                @keydown.escape.prevent="cancelEdit"
                @blur="commitEdit"
            >
            <AppTooltip
                v-else
                :text="item.title || t('bookmarks.untitled')"
                :delay-duration="800"
            >
                <span
                    class="pdf-bookmark-item-title"
                    :style="bookmarkTitleStyle"
                >
                    {{ item.title || t('bookmarks.untitled') }}
                </span>
            </AppTooltip>

            <AppTooltip
                v-if="treeContext.isEditMode.value"
                :text="t('bookmarks.actions')"
                :delay-duration="800"
            >
                <button
                    type="button"
                    class="pdf-bookmark-item-actions-trigger"
                    :aria-label="t('bookmarks.actions')"
                    @click.stop="openActionsFromButton"
                >
                    <UIcon
                        name="i-ph-dots-three"
                        class="size-4"
                    />
                </button>
            </AppTooltip>
        </div>

        <div
            v-if="hasChildren && isExpanded"
            class="pdf-bookmark-item-children"
        >
            <PdfOutlineItem
                v-for="(child, index) in item.items"
                :key="child.id || index"
                :item="child"
                :pdf-document="pdfDocument"
                @go-to-page="goToPage"
                @activate="activate"
                @toggle-expand="toggleExpandById"
                @open-actions="openActions"
                @save-edit="saveEdit"
                @cancel-edit="cancelChildEdit"
                @drag-start="startDrag"
                @drag-hover="hoverDrag"
                @drop-bookmark="dropBookmark"
                @drag-end="endDrag"
            />
        </div>
    </div>
</template>

<script setup lang="ts">

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IBookmarkItem,
    IBookmarkMenuPayload,
} from '@app/types/pdfOutline';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { navigateToBookmarkDestination } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/navigateToBookmarkDestination';
import { usePdfOutlineItemState } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineItemState';

const { t } = useTypedI18n();

type TDropPosition = 'before' | 'after' | 'child';

interface IDragHoverPayload {
    targetId: string;
    position: TDropPosition;
}

interface IProps {
    item: IBookmarkItem;
    pdfDocument: PDFDocumentProxy | null;
}

const {
    item,
    pdfDocument,
} = defineProps<IProps>();

const emit = defineEmits<{
    'go-to-page': [page: number, options?: IScrollToPageOptions];
    activate: [payload: {
        id: string;
        hasChildren: boolean;
        wasActive: boolean;
        multiSelect: boolean;
        rangeSelect: boolean;
    }];
    'toggle-expand': [id: string];
    'open-actions': [payload: IBookmarkMenuPayload];
    'save-edit': [payload: {
        id: string;
        title: string;
    }];
    'cancel-edit': [];
    'drag-start': [payload: { id: string }];
    'drag-hover': [payload: IDragHoverPayload];
    'drop-bookmark': [payload: IDragHoverPayload];
    'drag-end': [];
}>();

const {
    treeContext,
    hasChildren,
    isActive,
    isSelected,
    isEditing,
    isDragging,
    isDropTargetBefore,
    isDropTargetAfter,
    isDropTargetChild,
    isStyleRangeStart,
    bookmarkTitleStyle,
    isExpanded,
} = usePdfOutlineItemState(computed(() => item));

const editingTitle = ref('');
const titleInputRef = ref<HTMLInputElement | null>(null);

watch(
    isEditing,
    async (value) => {
        if (!value) {
            return;
        }

        editingTitle.value = item.title;
        await nextTick();
        titleInputRef.value?.focus();
        titleInputRef.value?.select();
    },
    { immediate: true },
);

watch(
    () => item.title,
    (value) => {
        if (!isEditing.value) {
            editingTitle.value = value;
        }
    },
    { immediate: true },
);

function openActions(payload: IBookmarkMenuPayload) {
    emit('open-actions', payload);
}

function toggleExpand() {
    emit('toggle-expand', item.id);
}

function toggleExpandById(id: string) {
    emit('toggle-expand', id);
}

function goToPage(page: number, options?: IScrollToPageOptions) {
    emit('go-to-page', page, options);
}

function activate(payload: {
    id: string;
    hasChildren: boolean;
    wasActive: boolean;
    multiSelect: boolean;
    rangeSelect: boolean;
}) {
    emit('activate', payload);
}

function saveEdit(payload: {
    id: string;
    title: string;
}) {
    emit('save-edit', payload);
}

function cancelChildEdit() {
    emit('cancel-edit');
}

function startDrag(payload: { id: string }) {
    emit('drag-start', payload);
}

function hoverDrag(payload: IDragHoverPayload) {
    emit('drag-hover', payload);
}

function dropBookmark(payload: IDragHoverPayload) {
    emit('drop-bookmark', payload);
}

function endDrag() {
    emit('drag-end');
}

function openActionsFromPointer(event: MouseEvent) {
    if (!treeContext.isEditMode.value) {
        return;
    }

    openActions({
        id: item.id,
        x: event.clientX,
        y: event.clientY,
    });
}

function openActionsFromButton(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    openActions({
        id: item.id,
        x: rect ? rect.right : event.clientX,
        y: rect ? rect.bottom : event.clientY,
    });
}

function commitEdit() {
    emit('save-edit', {
        id: item.id,
        title: editingTitle.value,
    });
}

function cancelEdit() {
    editingTitle.value = item.title;
    emit('cancel-edit');
}

function detectDropPosition(event: DragEvent): TDropPosition {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
        return 'after';
    }

    const rect = target.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const ratio = rect.height > 0 ? offsetY / rect.height : 0.5;

    if (ratio < 0.28) {
        return 'before';
    }
    if (ratio > 0.72) {
        return 'after';
    }
    return 'child';
}

function handleDragStart(event: DragEvent) {
    if (!treeContext.isEditMode.value || isEditing.value) {
        event.preventDefault();
        return;
    }

    event.dataTransfer?.setData('text/plain', item.id);
    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
    }
    emit('drag-start', { id: item.id });
}

function handleDragOver(event: DragEvent) {
    if (!treeContext.isEditMode.value || treeContext.draggingItemIds.value.size === 0) {
        return;
    }

    const position = detectDropPosition(event);
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
    }
    emit('drag-hover', {
        targetId: item.id,
        position,
    });
}

function handleDrop(event: DragEvent) {
    if (!treeContext.isEditMode.value || treeContext.draggingItemIds.value.size === 0) {
        return;
    }

    const position = detectDropPosition(event);
    emit('drop-bookmark', {
        targetId: item.id,
        position,
    });
}

function handleDragEnd() {
    if (!treeContext.isEditMode.value) {
        return;
    }
    emit('drag-end');
}

function resolveBookmarkSelectionIntent(event?: MouseEvent | KeyboardEvent) {
    const isMouseEvent = event instanceof MouseEvent;
    return {
        multiSelect: Boolean(isMouseEvent && (event.metaKey || event.ctrlKey)),
        rangeSelect: Boolean(isMouseEvent && event.shiftKey),
    };
}

function shouldSkipBookmarkNavigation(multiSelect: boolean, rangeSelect: boolean) {
    return isEditing.value || (treeContext.isEditMode.value && (multiSelect || rangeSelect));
}

function emitBookmarkActivation(multiSelect: boolean, rangeSelect: boolean) {
    const wasActive = isActive.value;
    emit('activate', {
        id: item.id,
        hasChildren: hasChildren.value,
        wasActive,
        multiSelect,
        rangeSelect,
    });
    return wasActive;
}

function shouldToggleBookmarkFromActivation(wasActive: boolean) {
    return wasActive && hasChildren.value;
}

function shouldIgnoreBookmarkClick(event?: MouseEvent | KeyboardEvent) {
    return event instanceof MouseEvent && event.button !== 0;
}

async function continueBookmarkClickNavigation(
    wasActive: boolean,
    multiSelect: boolean,
    rangeSelect: boolean,
    navigationRequestId: number,
) {
    if (shouldSkipBookmarkNavigation(multiSelect, rangeSelect)) {
        return;
    }

    if (shouldToggleBookmarkFromActivation(wasActive)) {
        emit('toggle-expand', item.id);
        return;
    }

    await navigateToBookmarkDestination({
        item,
        pdfDocument,
        navigationRequestId,
        isBookmarkNavigationRequestCurrent: treeContext.isBookmarkNavigationRequestCurrent,
        emitGoToPage: (page, options) => emit('go-to-page', page, options),
    });
}

async function handleClick(event?: MouseEvent | KeyboardEvent) {
    if (shouldIgnoreBookmarkClick(event)) {
        return;
    }

    const {
        multiSelect,
        rangeSelect,
    } = resolveBookmarkSelectionIntent(event);
    const navigationRequestId = treeContext.beginBookmarkNavigationRequest();
    const wasActive = emitBookmarkActivation(multiSelect, rangeSelect);
    await continueBookmarkClickNavigation(
        wasActive,
        multiSelect,
        rangeSelect,
        navigationRequestId,
    );
}
</script>

<style scoped>
.pdf-bookmark-item-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid transparent;
    transition:
        background-color 0.15s,
        border-color 0.15s,
        color 0.15s;
    user-select: none;
    outline: none;
}

.pdf-bookmark-item-row:hover {
    background: var(--app-sidebar-control-hover-bg);
}

.pdf-bookmark-item-row:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 35%, transparent 65%);
}

.pdf-bookmark-item-row.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text);
}

.pdf-bookmark-item-row.is-selected:not(.is-active) {
    background: color-mix(in srgb, var(--ui-primary) 10%, var(--app-sidebar-bg) 90%);
}

.pdf-bookmark-item-row.is-editing {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
}

.pdf-bookmark-item-row.is-dragging {
    opacity: 0.55;
}

.pdf-bookmark-item-row.is-drop-before::before,
.pdf-bookmark-item-row.is-drop-after::after {
    content: '';
    position: absolute;
    left: 4px;
    right: 4px;
    height: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

.pdf-bookmark-item-row.is-drop-before::before {
    top: -2px;
}

.pdf-bookmark-item-row.is-drop-after::after {
    bottom: -2px;
}

.pdf-bookmark-item-row.is-drop-child {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-primary) 45%, transparent 55%);
}

.pdf-bookmark-item-row.is-style-range-start {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-pdf-outline-range-indicator) 52%, transparent 48%);
}

.pdf-bookmark-item-drag-handle {
    width: 12px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-text-dimmed);
    opacity: 0.8;
}

.pdf-bookmark-item-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: none;
    color: var(--ui-text-muted);
    cursor: pointer;
    border-radius: 4px;
}

.pdf-bookmark-item-toggle:hover {
    background: var(--ui-bg-elevated);
}

.pdf-bookmark-item-spacer {
    width: 20px;
    flex-shrink: 0;
}

.pdf-bookmark-item-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pdf-bookmark-item-input {
    flex: 1;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    font-size: 12px;
    line-height: 1.4;
    padding: 3px 6px;
}

.pdf-bookmark-item-input:focus {
    outline: none;
    border-color: var(--ui-primary);
}

.pdf-bookmark-item-actions-trigger {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
}

.pdf-bookmark-item-actions-trigger:hover {
    color: var(--ui-text-highlighted);
    border-color: var(--ui-border);
    background: var(--ui-bg-elevated);
}

.pdf-bookmark-item-row:hover .pdf-bookmark-item-actions-trigger,
.pdf-bookmark-item-row.is-active .pdf-bookmark-item-actions-trigger,
.pdf-bookmark-item-row:focus-within .pdf-bookmark-item-actions-trigger {
    opacity: 1;
    pointer-events: auto;
}

.pdf-bookmark-item-children {
    padding-left: 16px;
}
</style>
