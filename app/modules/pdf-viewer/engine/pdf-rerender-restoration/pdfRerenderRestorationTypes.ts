import type { Ref } from 'vue';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';

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
    rerenderSource: TPdfRerenderSource;
    snapshotToRestore: IScrollSnapshot | null;
}

export interface IRerenderRestorationLoggerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    throttleMs: number;
}
