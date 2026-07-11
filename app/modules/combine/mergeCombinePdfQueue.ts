export interface ICombinePdfQueueMergeResult<T> {
    files: T[];
    rejected: number;
}

export function mergeCombinePdfQueue<T>(
    currentFiles: readonly T[],
    incomingFiles: FileList | File[],
    options: {
        isSupported: (file: File) => boolean;
        toQueueItem: (file: File) => T;
    },
): ICombinePdfQueueMergeResult<T> {
    const files = [...currentFiles];
    let rejected = 0;
    for (const file of Array.from(incomingFiles)) {
        if (!options.isSupported(file)) {
            rejected += 1;
            continue;
        }
        files.push(options.toQueueItem(file));
    }
    return {
        files,
        rejected,
    };
}
