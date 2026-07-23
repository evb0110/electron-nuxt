import { te } from '@electron/te';

const MAX_OPEN_INPUT_PATHS = 512;

export function assertOpenInputPathCount(paths: readonly unknown[]) {
    if (paths.length > MAX_OPEN_INPUT_PATHS) {
        throw new Error(te('errors.file.invalid'));
    }
}
