import type {Ref} from 'vue';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import {
    combinePdfFiles,
    CombinePdfError,
    type ICombinePdfProgress,
} from '@app/services/pdf/combinePdfFiles';
import {getDocumentsCapability} from '@app/utils/platformDocuments';
import {removeCompletedCombineSnapshot} from '@app/services/pdf/combineOperationSnapshot';

export const useCombinePdfOperation = <T extends {
    id: string;
    file: File;
    name: string
}>(options: {
    files: Ref<T[]>;
    openResult?: (result: TOpenFileResult) => Promise<boolean>;
    emitOpenResult: (result: TOpenFileResult) => void;
    translate: (key: string) => string;
}) => {
    const isCombining = ref(false);
    const progress = ref<ICombinePdfProgress | null>(null);
    const combineError = ref<string | null>(null);
    const pendingCombinedResult = ref<TOpenFileResult | null>(null);
    const queueMutationLocked = computed(() => (
        isCombining.value || pendingCombinedResult.value !== null
    ));
    let abortController: AbortController | null = null;

    function buildOutputName(operationFiles: readonly T[]) {
        return operationFiles.length === 1
            ? operationFiles[0]!.name.replace(/\.[^.]+$/u, '.pdf')
            : `combined-${Date.now()}.pdf`;
    }

    async function combine() {
        if (options.files.value.length === 0 || isCombining.value) {
            return;
        }
        const snapshot = Object.freeze(options.files.value.map(file => Object.freeze({...file})));
        isCombining.value = true;
        abortController = new AbortController();
        combineError.value = null;
        progress.value = {
            processed: 0,
            total: snapshot.length,
            percent: 0,
            elapsedMs: 0,
            estimatedRemainingMs: null,
        };
        try {
            const result = pendingCombinedResult.value ?? await combinePdfFiles({
                files: snapshot,
                outputName: buildOutputName(snapshot),
                openErrorMessage: options.translate('errors.file.open'),
                onProgress: next => { progress.value = next; },
                signal: abortController.signal,
            });
            pendingCombinedResult.value = result;
            const opened = options.openResult ? await options.openResult(result) : true;
            if (!opened) throw new Error('ERR_COMBINE_RESULT_OPEN_FAILED');
            if (!options.openResult) options.emitOpenResult(result);
            pendingCombinedResult.value = null;
            options.files.value = removeCompletedCombineSnapshot(options.files.value, snapshot);
            progress.value = null;
        } catch (error) {
            progress.value = null;
            combineError.value = error instanceof CombinePdfError && error.code === 'canceled'
                ? null
                : error instanceof CombinePdfError && [
                    'invalid-input',
                    'limit',
                    'unsupported',
                ].includes(error.code)
                    ? options.translate('errors.file.invalid')
                    : options.translate('errors.file.open');
        } finally {
            abortController = null;
            isCombining.value = false;
        }
    }

    function cancel() {
        abortController?.abort(new DOMException('PDF combine was canceled.', 'AbortError'));
    }

    async function savePendingAs() {
        const pending = pendingCombinedResult.value;
        if (!pending || isCombining.value) {
            return;
        }
        try {
            const savedPath = await getDocumentsCapability().savePdfAs(pending.workingPath, undefined);
            if (savedPath) combineError.value = null;
        } catch {
            combineError.value = options.translate('errors.file.save');
        }
    }

    return {
        isCombining,
        progress,
        combineError,
        pendingCombinedResult,
        queueMutationLocked,
        combine,
        cancel,
        savePendingAs,
    };
};
