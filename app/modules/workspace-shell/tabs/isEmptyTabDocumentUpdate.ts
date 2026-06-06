import type { TTabUpdate } from '@app/types/tabs';

export function isEmptyTabDocumentUpdate(update: TTabUpdate) {
    return update.fileName === null
        && update.originalPath === null
        && update.isDirty === false
        && update.isDjvu === false;
}
