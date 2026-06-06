import type { Ref } from 'vue';
import type { IScrollSnapshot } from '@app/types/pdf';

export interface IRoundedScrollPosition {
    scrollTop: number | null;
    scrollLeft: number | null;
}

export type TRerenderRestoreMode = 'preserve' | 'full';

export interface IRerenderRestorationContext {
    version: number;
    preserveExistingPages: boolean;
    anchorSnapshot: IScrollSnapshot | null;
    disableHorizontalAnchorRestore: boolean;
    disableVerticalAnchorRestore: boolean;
    disablePageAnchorRestore: boolean;
    rerenderSource: string;
    snapshotToRestore: IScrollSnapshot | null;
}

export interface IRerenderRestorationLoggerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    throttleMs: number;
}
