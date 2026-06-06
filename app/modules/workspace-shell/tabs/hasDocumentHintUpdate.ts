import type { TTabUpdate } from '@app/types/tabs';

export function hasDocumentHintUpdate(update: TTabUpdate) {
    return Boolean(update.fileName || update.originalPath || update.isDjvu);
}
