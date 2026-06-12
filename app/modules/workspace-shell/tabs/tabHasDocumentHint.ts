import type { ITab } from '@app/types/tabs';

export function tabHasDocumentHint(tab: Pick<ITab, 'fileName' | 'originalPath' | 'isDjvu'>) {
    return Boolean(tab.fileName) || Boolean(tab.originalPath) || tab.isDjvu === true;
}
