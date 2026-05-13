import type {
    IPlatformApi,
    IViewerHostApi,
    TDocumentRef,
} from '@contracts/platformApi';
import {
    getPlatformAPI,
    hasElectronAPI,
} from '@app/utils/platform';
import { getViewerAssetResolver } from '@app/utils/viewerAssets';

function isMobileViewport() {
    if (typeof window === 'undefined') {
        return false;
    }

    return window.matchMedia('(max-width: 767px)').matches
        || window.matchMedia('(pointer: coarse)').matches;
}

function isStandaloneDisplayMode() {
    if (typeof window === 'undefined') {
        return false;
    }

    return window.matchMedia('(display-mode: standalone)').matches;
}

function createViewerDocumentsCapability(api: IPlatformApi): IViewerHostApi['documents'] {
    return {
        stat: (ref: TDocumentRef) => api.documents.statFile(ref),
        read: (ref: TDocumentRef) => api.documents.readFile(ref),
        readRange: (ref: TDocumentRef, offset: number, length: number) => api.documents.readFileRange(ref, offset, length),
        pickDocument: () => api.documents.openPdfDialog(),
        openRecent: (ref: TDocumentRef) => api.documents.openPdfDirect(ref),
        save: async (ref: TDocumentRef, bytes: Uint8Array) => {
            const ok = await api.documents.writeFile(ref, bytes);
            return ok ? ref : null;
        },
        saveAs: async (suggestedName: string, bytes: Uint8Array) => {
            const target = await api.documents.savePdfDialog(suggestedName);
            if (!target) {
                return null;
            }
            const ok = await api.documents.writeFile(target, bytes);
            return ok ? target : null;
        },
    };
}

export function getViewerHostApi(): IViewerHostApi {
    const api = getPlatformAPI();
    return {
        environment: {
            kind: hasElectronAPI() ? 'electron' : 'browser',
            isMobile: isMobileViewport(),
            isStandalone: isStandaloneDisplayMode(),
        },
        assets: getViewerAssetResolver(),
        documents: createViewerDocumentsCapability(api),
        search: api.search,
        settings: api.settings,
        shell: api.shell,
    };
}
