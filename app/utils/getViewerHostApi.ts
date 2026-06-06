import type {
    IPlatformApi,
    IViewerHostApi,
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
        stat: (ref) => api.documents.statFile(ref),
        read: (ref) => api.documents.readFile(ref),
        readRange: (ref, offset, length) => api.documents.readFileRange(ref, offset, length),
        pickDocument: () => api.documents.openDocumentDialog(),
        openRecent: (ref) => api.documents.openDocumentDirect(ref),
        save: async (ref, bytes) => {
            const ok = await api.documents.writeFile(ref, bytes);
            return ok ? ref : null;
        },
        saveAs: async (suggestedName, bytes) => {
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
