import type { IViewerHostApi } from '@contracts/viewerHost';
import { hasElectronAPI } from '@app/utils/platform';
import { getViewerAssetResolver } from '@app/utils/viewerAssets';
import {
    getDocumentFilesCapability,
    getDocumentOpenCapability,
    getDocumentPickerCapability,
} from '@app/utils/platformDocuments';
import { getSearchCapability } from '@app/utils/getSearchCapability';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { getShellCapability } from '@app/utils/getShellCapability';

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

function createViewerDocumentsCapability(): IViewerHostApi['documents'] {
    const documentFiles = getDocumentFilesCapability();
    const documentOpen = getDocumentOpenCapability();
    const documentPicker = getDocumentPickerCapability();

    return {
        stat: (ref) => documentFiles.statFile(ref),
        read: (ref) => documentFiles.readFile(ref),
        readRange: (ref, offset, length) => documentFiles.readFileRange(ref, offset, length),
        pickDocument: () => documentPicker.openDocumentDialog(),
        openRecent: (ref) => documentOpen.openDocumentDirect(ref),
        save: async (ref, bytes) => {
            const ok = await documentFiles.writeFile(ref, bytes);
            return ok ? ref : null;
        },
        saveAs: async (suggestedName, bytes) => {
            const target = await documentFiles.savePdfDialog(suggestedName);
            if (!target) {
                return null;
            }
            const ok = await documentFiles.writeFile(target, bytes);
            return ok ? target : null;
        },
    };
}

export function getViewerHostApi(): IViewerHostApi {
    return {
        environment: {
            kind: hasElectronAPI() ? 'electron' : 'browser',
            isMobile: isMobileViewport(),
            isStandalone: isStandaloneDisplayMode(),
        },
        assets: getViewerAssetResolver(),
        documents: createViewerDocumentsCapability(),
        search: getSearchCapability(),
        settings: getSettingsCapability(),
        shell: getShellCapability(),
    };
}
