<template>
    <AppToolPageShell
        :title="t('combinePdf.title')"
        :eyebrow="t('combinePdf.pageEyebrow')"
        icon="i-ph-stack-plus"
        :show-back="showBack"
        :show-eyebrow="showEyebrow"
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

                <ol class="combine-file-list">
                    <li
                        v-for="(file, index) in files"
                        :key="file.id"
                        class="combine-file-row"
                    >
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
                    <UProgress :value="progress.percent" />
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
import AppToolPageShell from '@app/components/AppToolPageShell.vue';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import { formatBytes } from '@app/utils/formatters';
import { getErrorMessage } from '@app/utils/error';
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
} = defineProps<{
    showBack?: boolean;
    showEyebrow?: boolean;
}>();

const { t } = useTypedI18n();
const listTitleId = useId();
const fileInputRef = ref<HTMLInputElement | null>(null);
const files = ref<ICombineFile[]>([]);
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

function getFileKind(fileName: string): TCombineFileKind {
    return getDocumentKindFromPath(fileName);
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
        kind: getFileKind(file.name),
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

function reorderFile(filesToReorder: readonly ICombineFile[], index: number, targetIndex: number) {
    const file = filesToReorder[index];
    if (!file) {
        return [...filesToReorder];
    }

    const withoutFile = filesToReorder.filter((_, fileIndex) => fileIndex !== index);
    return [
        ...withoutFile.slice(0, targetIndex),
        file,
        ...withoutFile.slice(targetIndex),
    ];
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

function moveFile(index: number, delta: -1 | 1) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= files.value.length) {
        return;
    }

    files.value = reorderFile(files.value, index, targetIndex);
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
    gap: 1.25rem;
    width: min(100%, 76rem);
    height: 100%;
    min-height: 0;
    margin: 0 auto;
}

.combine-page.is-empty {
    grid-template-columns: minmax(0, 1fr);
    width: min(100%, 45rem);
}

.combine-page.has-files {
    grid-template-columns: minmax(20rem, 0.6fr) minmax(0, 1fr);
}

.combine-dropzone,
.combine-workbench {
    border: 1px solid var(--app-start-card-border);
    border-radius: 0.5rem;
    background: var(--app-start-card-bg);
}

.combine-dropzone {
    position: sticky;
    top: 0;
    display: flex;
    align-self: start;
    min-height: 22rem;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 1.25rem;
    border-style: dashed;
    border-color: var(--app-start-dropzone-border);
    background: var(--app-start-dropzone-bg);
    text-align: center;
}

.combine-page.is-empty .combine-dropzone {
    min-height: 22.5rem;
}

.combine-page.is-dragging .combine-dropzone {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 88%, var(--ui-primary) 12%);
}

.combine-dropzone-art {
    display: inline-flex;
    width: 4.5rem;
    height: 4.5rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-primary);
}

.combine-dropzone-icon {
    width: 2rem;
    height: 2rem;
}

.combine-dropzone-copy {
    display: flex;
    max-width: 18rem;
    flex-direction: column;
    gap: 0.35rem;
}

.combine-dropzone-copy h2 {
    margin: 0;
    color: var(--ui-text-highlighted);
    font-size: 1.05rem;
    font-weight: 650;
    letter-spacing: 0;
}

.combine-dropzone-copy p {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: 0.86rem;
    line-height: 1.45;
}

.combine-dropzone-alerts {
    display: grid;
    width: min(100%, 24rem);
    gap: 0.5rem;
}

.combine-workbench {
    display: flex;
    min-width: 0;
    min-height: 28rem;
    max-height: 100%;
    flex-direction: column;
    gap: 0.9rem;
    overflow: hidden;
    padding: 1rem;
}

.combine-list-header,
.combine-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}

.combine-list-title {
    margin: 0;
    color: var(--ui-text-highlighted);
    font-size: 1rem;
    font-weight: 650;
    letter-spacing: 0;
}

.combine-list-meta,
.combine-actions p {
    margin: 0.2rem 0 0;
    color: var(--ui-text-muted);
    font-size: 0.8rem;
}

.combine-file-list {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
}

.combine-file-row {
    display: grid;
    grid-template-columns: 2rem 2rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    min-height: 3.25rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.45rem;
    background: var(--ui-bg);
}

.combine-file-index {
    color: var(--ui-text-dimmed);
    font-variant-numeric: tabular-nums;
    text-align: center;
}

.combine-file-icon {
    width: 1.55rem;
    height: 1.85rem;
}

.combine-file-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.15rem;
}

.combine-file-copy strong {
    overflow: hidden;
    color: var(--ui-text);
    font-size: 0.87rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.combine-file-copy span {
    color: var(--ui-text-muted);
    font-size: 0.76rem;
}

.combine-row-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
}

.combine-progress {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    gap: 0.45rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.45rem;
    background: var(--ui-bg-muted);
    padding: 0.65rem 0.75rem;
}

.combine-progress-copy {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    color: var(--ui-text-muted);
    font-size: 0.8rem;
}

.combine-progress-copy span:first-child {
    color: var(--ui-text);
    font-weight: 600;
}

.combine-actions {
    flex-shrink: 0;
    position: sticky;
    bottom: 0;
    margin-top: auto;
    border-top: 1px solid var(--app-start-row-divider);
    background: var(--app-start-card-bg);
    padding-top: 0.85rem;
}

@media (width <= 760px) {
    .combine-page {
        grid-template-columns: minmax(0, 1fr);
    }

    .combine-dropzone {
        position: static;
        min-height: 16rem;
    }
}

@media (width <= 520px) {
    .combine-list-header,
    .combine-actions {
        align-items: stretch;
        flex-direction: column;
    }

    .combine-file-row {
        grid-template-columns: 1.5rem 1.75rem minmax(0, 1fr);
    }

    .combine-row-actions {
        grid-column: 3;
        justify-self: end;
    }
}
</style>
