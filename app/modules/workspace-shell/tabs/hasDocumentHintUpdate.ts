import type { TTabUpdate } from '@app/types/tabs';

export function hasDocumentHintUpdate(update: TTabUpdate) {
    return Boolean(update.fileName) || Boolean(update.originalPath) || update.isDjvu === true;
}
