<template>
    <AppToolPageShell
        :title="t('combinePdf.title')"
        :eyebrow="t('combinePdf.pageEyebrow')"
        icon="i-ph-stack-plus"
        :show-back="showBack"
        :show-eyebrow="showEyebrow"
        :show-header="showHeader"
        @close="closePage"
    >
        <div
            class="combine-page"
            data-combine-page
            :class="[
                files.length > 0 ? 'has-files' : 'is-empty',
                { 'is-dragging': isDraggingOver },
            ]"
            @dragenter.prevent="handleDragEnter"
            @dragover.prevent="handleDragOver"
            @dragleave="handleDragLeave"
            @drop.prevent="handleDrop"
        >
            <section
                class="combine-dropzone"
                data-combine-drop-zone
            >
                <input
                    ref="fileInputRef"
                    class="sr-only"
                    type="file"
                    multiple
                    :accept="COMBINE_FILE_ACCEPT"
                    @change="handleFileInputChange"
                >
                <span class="combine-dropzone-art" aria-hidden="true">
                    <UIcon name="i-ph-files" class="combine-dropzone-icon" />
                </span>
                <div class="combine-dropzone-copy">
                    <h2>{{ t('combinePdf.dropTitle') }}</h2>
                    <p>{{ t('combinePdf.dropDescription') }}</p>
                </div>
                <UButton
                    color="primary"
                    icon="i-ph-folder-open"
                    :label="files.length > 0 ? t('combinePdf.addMore') : t('combinePdf.chooseFiles')"
                    :disabled="isCombining"
                    @click="openFileInput"
                />
                <div
                    v-if="files.length === 0 && (lastRejectedCount > 0 || combineError)"
                    class="combine-dropzone-alerts"
                >
                    <UAlert
                        v-if="lastRejectedCount > 0"
                        color="warning"
                        variant="soft"
                        icon="i-ph-warning-circle"
                        :description="t('combinePdf.unsupportedFiles', { count: lastRejectedCount })"
                    />
                    <UAlert
                        v-if="combineError"
                        color="error"
                        variant="soft"
                        icon="i-ph-warning"
                        :description="combineError"
                    />
                </div>
            </section>

            <section
                v-if="files.length > 0"
                class="combine-workbench"
                :aria-labelledby="listTitleId"
            >
                <header class="combine-list-header">
                    <div>
                        <h2 :id="listTitleId" class="combine-list-title">
                            {{ t('combinePdf.listTitle') }}
                        </h2>
                        <p class="combine-list-meta">
                            {{ filesLabel }}
                        </p>
                    </div>
                    <UButton
                        v-if="files.length > 0"
                        color="neutral"
                        variant="ghost"
                        icon="i-ph-trash"
                        :label="t('combinePdf.clear')"
                        :disabled="isCombining"
                        @click="clearFiles"
                    />
                </header>

                <UAlert
                    v-if="lastRejectedCount > 0"
                    color="warning"
                    variant="soft"
                    icon="i-ph-warning-circle"
                    :description="t('combinePdf.unsupportedFiles', { count: lastRejectedCount })"
                />

                <UAlert
                    v-if="combineError"
                    color="error"
                    variant="soft"
                    icon="i-ph-warning"
                    :description="combineError"
                />

                <p class="sr-only" role="status" aria-live="polite">{{ reorderAnnouncement }}</p>

                <ol
                    ref="listRef"
                    class="combine-file-list"
                    :class="{ 'is-reordering': isReordering }"
                >
                    <li
                        v-for="(file, index) in files"
                        :key="file.id"
                        class="combine-file-row"
                        :class="{ 'is-row-dragging': reorderDragIndex === index }"
                        data-combine-row
                    >
                        <AppTooltip :text="t('combinePdf.dragToReorder')" :delay-duration="600">
                            <span
                                class="combine-drag-handle"
                                aria-hidden="true"
                                @pointerdown="(event) => startReorder(event, index)"
                            >
                                <UIcon name="i-ph-dots-six-vertical" class="size-4" />
                            </span>
                        </AppTooltip>
                        <span class="combine-file-index">{{ index + 1 }}</span>
                        <FileTypeIcon :kind="file.kind" class="combine-file-icon" />
                        <span class="combine-file-copy">
                            <strong>{{ file.name }}</strong>
                            <span>{{ formatBytes(file.size) }}</span>
                        </span>
                        <span class="combine-row-actions">
                            <AppTooltip :text="t('combinePdf.moveUp')" :delay-duration="600">
                                <UButton
                                    color="neutral"
                                    variant="ghost"
                                    size="xs"
                                    icon="i-ph-caret-up"
                                    :aria-label="t('combinePdf.moveUp')"
                                    :disabled="index === 0 || isCombining"
                                    @click="moveFile(index, -1)"
                                />
                            </AppTooltip>
                            <AppTooltip :text="t('combinePdf.moveDown')" :delay-duration="600">
                                <UButton
                                    color="neutral"
                                    variant="ghost"
                                    size="xs"
                                    icon="i-ph-caret-down"
                                    :aria-label="t('combinePdf.moveDown')"
                                    :disabled="index === files.length - 1 || isCombining"
                                    @click="moveFile(index, 1)"
                                />
                            </AppTooltip>
                            <AppTooltip :text="t('combinePdf.removeFile')" :delay-duration="600">
                                <UButton
                                    color="neutral"
                                    variant="ghost"
                                    size="xs"
                                    icon="i-ph-x"
                                    :aria-label="t('combinePdf.removeFile')"
                                    :disabled="isCombining"
                                    @click="removeFile(index)"
                                />
                            </AppTooltip>
                        </span>
                    </li>
                </ol>

                <div v-if="progress" class="combine-progress" role="status" aria-live="polite">
                    <div class="combine-progress-copy">
                        <span>{{ t('combinePdf.progressTitle') }}</span>
                        <span>
                            {{ t('combinePdf.progressDetail', {
                                processed: progress.processed,
                                total: progress.total,
                            }) }}
                        </span>
                    </div>
                    <AppProgressBar :value="progress.percent" />
                </div>

                <footer class="combine-actions">
                    <p>{{ t('combinePdf.outputHint') }}</p>
                    <UButton
                        color="primary"
                        icon="i-ph-stack-plus"
                        :loading="isCombining"
                        :label="isCombining ? t('combinePdf.combining') : t('combinePdf.combineCountAction', { count: files.length })"
                        @click="combineFiles"
                    />
                </footer>
            </section>
        </div>
    </AppToolPageShell>
</template>

<script setup lang="ts">
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppToolPageShell from '@app/components/AppToolPageShell.vue';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import { formatBytes } from '@app/utils/formatters';
import { getErrorMessage } from '@app/utils/error';
import { moveArrayItem } from '@app/utils/moveArrayItem';
import {
    combinePdfFiles as combinePdfInputFiles,
    type ICombinePdfProgress,
} from '@app/services/pdf/combinePdfFiles';
import {
    getDocumentKindFromPath,
    isSupportedWorkspaceDocumentPath,
    WORKSPACE_DOCUMENT_EXTENSIONS,
} from '@app/utils/supportedDocumentPaths';

type TCombineFileKind = 'pdf' | 'djvu' | 'image' | 'document';

interface ICombineFile {
    id: string;
    file: File;
    name: string;
    size: number;
    signature: string;
    kind: TCombineFileKind;
}

const emit = defineEmits<{
    'close': [];
    'open-result': [result: TOpenFileResult];
}>();

function closePage() {
    emit('close');
}

const {
    showBack = true,
    showEyebrow = true,
    showHeader = true,
} = defineProps<{
    showBack?: boolean;
    showEyebrow?: boolean;
    showHeader?: boolean;
}>();

const { t } = useTypedI18n();
const listTitleId = useId();
const fileInputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const files = ref<ICombineFile[]>([]);
const reorderAnnouncement = ref('');
const isDraggingOver = ref(false);
const dragDepth = ref(0);
const isCombining = ref(false);
const progress = ref<ICombinePdfProgress | null>(null);
const combineError = ref<string | null>(null);
const lastRejectedCount = ref(0);
const COMBINE_FILE_ACCEPT = WORKSPACE_DOCUMENT_EXTENSIONS.join(',');

const filesLabel = computed(() => t('combinePdf.fileCount', { count: files.value.length }));

function isSupportedCombineFile(file: File) {
    return isSupportedWorkspaceDocumentPath(file.name);
}

function createFileSignature(file: File) {
    return [
        file.name,
        file.size,
        file.lastModified,
    ].join(':');
}

function toCombineFile(file: File): ICombineFile {
    return {
        id: crypto.randomUUID(),
        file,
        name: file.name,
        size: file.size,
        signature: createFileSignature(file),
        kind: getDocumentKindFromPath(file.name),
    };
}

function mergeCombineFiles(currentFiles: readonly ICombineFile[], fileList: FileList | File[]) {
    return Array.from(fileList).reduce<{
        files: ICombineFile[];
        signatures: Set<string>;
        rejected: number;
    }>((result, file) => {
        if (!isSupportedCombineFile(file)) {
            return {
                ...result,
                rejected: result.rejected + 1,
            };
        }

        const signature = createFileSignature(file);
        if (result.signatures.has(signature)) {
            return result;
        }

        return {
            files: [
                ...result.files,
                toCombineFile(file),
            ],
            signatures: new Set([
                ...result.signatures,
                signature,
            ]),
            rejected: result.rejected,
        };
    }, {
        files: [...currentFiles],
        signatures: new Set(currentFiles.map(file => file.signature)),
        rejected: 0,
    });
}

function addFiles(fileList: FileList | File[]) {
    combineError.value = null;
    const merged = mergeCombineFiles(files.value, fileList);

    lastRejectedCount.value = merged.rejected;
    files.value = merged.files;
}

function openFileInput() {
    fileInputRef.value?.click();
}

function handleFileInputChange(event: Event) {
    const input = event.target as HTMLInputElement | null;
    if (input?.files) {
        addFiles(input.files);
    }
    if (input) {
        input.value = '';
    }
}

function handleDragEnter() {
    dragDepth.value += 1;
    isDraggingOver.value = true;
}

function handleDragOver(event: DragEvent) {
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
}

function handleDragLeave() {
    dragDepth.value = Math.max(0, dragDepth.value - 1);
    if (dragDepth.value === 0) {
        isDraggingOver.value = false;
    }
}

function handleDrop(event: DragEvent) {
    dragDepth.value = 0;
    isDraggingOver.value = false;
    if (event.dataTransfer?.files) {
        addFiles(event.dataTransfer.files);
    }
}

function clearFiles() {
    files.value = [];
    lastRejectedCount.value = 0;
    combineError.value = null;
    progress.value = null;
}

function removeFile(index: number) {
    files.value = files.value.filter((_, fileIndex) => fileIndex !== index);
}

function announceReorder(position: number) {
    const file = files.value[position];
    if (!file) {
        return;
    }
    reorderAnnouncement.value = t('combinePdf.reorderAnnouncement', {
        name: file.name,
        position: position + 1,
        total: files.value.length,
    });
}

function moveFile(index: number, delta: -1 | 1) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= files.value.length) {
        return;
    }

    files.value = moveArrayItem(files.value, index, targetIndex);
    announceReorder(targetIndex);
}

function handleReorder(fromIndex: number, toIndex: number) {
    files.value = moveArrayItem(files.value, fromIndex, toIndex);
    announceReorder(toIndex);
}

const {
    isDragging: isReordering,
    dragIndex: reorderDragIndex,
    onPointerDown: onReorderPointerDown,
} = useListDragReorder(listRef, '[data-combine-row]', handleReorder);

function startReorder(event: PointerEvent, index: number) {
    if (isCombining.value) {
        return;
    }
    onReorderPointerDown(event, index);
}

function buildOutputName() {
    if (files.value.length === 1) {
        return files.value[0]!.name.replace(/\.[^.]+$/u, '.pdf');
    }
    return `combined-${Date.now()}.pdf`;
}

function handleCombineProgress(nextProgress: ICombinePdfProgress) {
    progress.value = nextProgress;
}

async function combineFiles() {
    if (files.value.length === 0 || isCombining.value) {
        return;
    }

    isCombining.value = true;
    combineError.value = null;
    lastRejectedCount.value = 0;
    progress.value = {
        processed: 0,
        total: files.value.length,
        percent: 0,
        elapsedMs: 0,
        estimatedRemainingMs: null,
    };

    try {
        const result = await combinePdfInputFiles({
            files: files.value,
            outputName: buildOutputName(),
            openErrorMessage: t('errors.file.open'),
            onProgress: handleCombineProgress,
        });
        emit('open-result', result);
        clearFiles();
    } catch (error) {
        combineError.value = getErrorMessage(error) || t('errors.file.open');
    } finally {
        isCombining.value = false;
    }
}
</script>

<style scoped>
.combine-page {
    display: grid;
    align-items: stretch;
    gap: var(--app-combine-page-gap);
    width: min(100%, var(--app-combine-page-max-width));
    height: 100%;
    min-height: 0;
    margin: 0 auto;
}

.combine-page.is-empty {
    grid-template-columns: minmax(0, 1fr);
    width: min(100%, var(--app-combine-empty-page-max-width));
}

.combine-page.has-files {
    grid-template-columns: minmax(var(--app-combine-rail-min-width), 0.6fr) minmax(0, 1fr);
}

.combine-dropzone,
.combine-workbench {
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-start-panel-radius);
    background: var(--app-start-card-bg);
}

.combine-dropzone {
    position: sticky;
    top: 0;
    display: flex;
    align-self: start;
    min-height: var(--app-combine-dropzone-min-height);
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-combine-dropzone-gap);
    padding: var(--app-combine-dropzone-padding);
    border-style: dashed;
    border-color: var(--app-start-dropzone-border);
    background: var(--app-start-dropzone-bg);
    text-align: center;
}

.combine-page.is-empty .combine-dropzone {
    min-height: var(--app-combine-empty-dropzone-min-height);
}

.combine-page.is-dragging .combine-dropzone {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 88%, var(--ui-primary) 12%);
}

.combine-dropzone-art {
    display: inline-flex;
    width: var(--app-combine-dropzone-art-size);
    height: var(--app-combine-dropzone-art-size);
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    background: var(--ui-bg);
    color: var(--ui-primary);
}

.combine-dropzone-icon {
    width: var(--app-combine-dropzone-icon-size);
    height: var(--app-combine-dropzone-icon-size);
}

.combine-dropzone-copy {
    display: flex;
    max-width: var(--app-content-width-xs);
    flex-direction: column;
    gap: var(--app-combine-dropzone-copy-gap);
}

.combine-dropzone-copy h2 {
    margin: 0;
    color: var(--ui-text-highlighted);
    font-size: var(--app-combine-dropzone-copy-title-size);
    font-weight: var(--app-font-weight-heading);
    letter-spacing: 0;
}

.combine-dropzone-copy p {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-combine-dropzone-copy-text-size);
    line-height: var(--app-line-height-body);
}

.combine-dropzone-alerts {
    display: grid;
    width: min(100%, var(--app-combine-dropzone-alert-width));
    gap: var(--app-space-3xl);
}

.combine-workbench {
    display: flex;
    min-width: 0;
    min-height: var(--app-combine-workbench-min-height);
    max-height: 100%;
    flex-direction: column;
    gap: var(--app-combine-workbench-gap);
    overflow: hidden;
    padding: var(--app-combine-workbench-padding);
}

.combine-list-header,
.combine-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-start-panel-gap);
}

.combine-list-title {
    margin: 0;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-title-sm);
    font-weight: var(--app-font-weight-heading);
    letter-spacing: 0;
}

.combine-list-meta,
.combine-actions p {
    margin: 0.2rem 0 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.combine-file-list {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: var(--app-combine-file-list-gap);
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
}

.combine-file-row {
    display: grid;
    grid-template-columns: var(--app-combine-file-row-columns);
    align-items: center;
    gap: var(--app-combine-file-row-gap);
    min-height: var(--app-combine-file-row-min-height);
    padding: var(--app-combine-file-row-padding);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-xl);
    background: var(--ui-bg);
}

.combine-drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-text-dimmed);
    cursor: grab;
    touch-action: none;
    user-select: none;
}

.combine-drag-handle:hover {
    color: var(--ui-text-muted);
}

.combine-drag-handle:active {
    cursor: grabbing;
}

.combine-file-list.is-reordering {
    cursor: grabbing;
    user-select: none;
}

.combine-file-row.is-row-dragging {
    position: relative;
    z-index: 1;
    border-color: var(--ui-primary);
    background: var(--ui-bg-elevated);
    box-shadow: var(--shadow-popup);
}

.combine-file-index {
    color: var(--ui-text-dimmed);
    font-variant-numeric: tabular-nums;
    text-align: center;
}

.combine-file-icon {
    width: var(--app-combine-file-icon-width);
    height: var(--app-combine-file-icon-height);
}

.combine-file-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--app-combine-file-copy-gap);
}

.combine-file-copy strong {
    overflow: hidden;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.combine-file-copy span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-meta);
}

.combine-row-actions {
    display: flex;
    align-items: center;
    gap: var(--app-space-2xs);
}

.combine-progress {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    gap: var(--app-space-2xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-xl);
    background: var(--ui-bg-muted);
    padding: var(--app-combine-progress-padding);
}

.combine-progress-copy {
    display: flex;
    justify-content: space-between;
    gap: var(--app-start-panel-gap);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
}

.combine-progress-copy span:first-child {
    color: var(--ui-text);
    font-weight: var(--app-font-weight-semibold);
}

.combine-actions {
    flex-shrink: 0;
    position: sticky;
    bottom: 0;
    margin-top: auto;
    border-top: 1px solid var(--app-start-row-divider);
    background: var(--app-start-card-bg);
    padding-top: var(--app-combine-actions-padding-top);
}

@container (max-width: 991px) {
    .combine-page.has-files {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
    }

    .combine-page.has-files .combine-workbench {
        min-height: 0;
    }

    .combine-page.has-files .combine-dropzone {
        position: static;
        min-height: 0;
        flex-direction: row;
        align-items: center;
        justify-content: flex-start;
        gap: var(--app-combine-compact-dropzone-gap);
        padding: var(--app-combine-compact-dropzone-padding);
        border-width: 1.5px;
        text-align: left;
    }

    .combine-page.has-files .combine-dropzone-art {
        width: var(--app-combine-compact-dropzone-art-size);
        height: var(--app-combine-compact-dropzone-art-size);
        flex: 0 0 auto;
        border-radius: var(--app-radius-xl);
    }

    .combine-page.has-files .combine-dropzone-icon {
        width: var(--app-combine-compact-dropzone-icon-size);
        height: var(--app-combine-compact-dropzone-icon-size);
    }

    .combine-page.has-files .combine-dropzone-copy {
        max-width: none;
        min-width: 0;
        flex: 1 1 auto;
        gap: var(--app-combine-compact-copy-gap);
    }

    .combine-page.has-files .combine-dropzone-copy h2 {
        font-size: var(--app-combine-compact-title-size);
    }

    .combine-page.has-files .combine-dropzone-copy p {
        display: none;
    }

    .combine-page.has-files .combine-dropzone :deep(button) {
        flex: 0 0 auto;
    }
}

@container (max-width: 520px) {
    .combine-list-header {
        align-items: stretch;
        flex-direction: column;
    }

    .combine-file-row {
        grid-template-columns: var(--app-combine-small-row-columns);
    }

    .combine-row-actions {
        grid-column: 4;
        justify-self: end;
    }
}

@container (max-width: 430px) {
    .combine-actions {
        align-items: stretch;
        flex-direction: column;
    }
}
</style>
