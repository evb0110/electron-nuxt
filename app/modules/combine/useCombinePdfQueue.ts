import type {Ref} from 'vue';
import {mergeCombinePdfQueue} from '@app/modules/combine/mergeCombinePdfQueue';
import {moveArrayItem} from '@app/utils/moveArrayItem';
import {canMutateCombineFiles} from '@app/services/pdf/combineOperationSnapshot';

export const useCombinePdfQueue = <T>(options: {
    files: Ref<T[]>;
    isCombining: Ref<boolean>;
    isSupported: (file: File) => boolean;
    toQueueItem: (file: File) => T;
}) => {
    const files = options.files;
    const lastRejectedCount = ref(0);

    function addFiles(fileList: FileList | File[]) {
        if (!canMutateCombineFiles(options.isCombining.value)) {
            return;
        }
        const merged = mergeCombinePdfQueue(files.value, fileList, options);
        files.value = merged.files;
        lastRejectedCount.value = merged.rejected;
    }
    function clearFiles() {
        if (!canMutateCombineFiles(options.isCombining.value)) {
            return false;
        }
        files.value = [];
        lastRejectedCount.value = 0;
        return true;
    }
    function removeFile(index: number) {
        if (!canMutateCombineFiles(options.isCombining.value)) {
            return;
        }
        files.value = files.value.filter((_file, fileIndex) => fileIndex !== index);
    }
    function moveFile(index: number, targetIndex: number) {
        if (!canMutateCombineFiles(options.isCombining.value) || targetIndex < 0 || targetIndex >= files.value.length) {
            return false;
        }
        files.value = moveArrayItem(files.value, index, targetIndex);
        return true;
    }

    return {
        files,
        lastRejectedCount,
        addFiles,
        clearFiles,
        removeFile,
        moveFile,
    };
};
