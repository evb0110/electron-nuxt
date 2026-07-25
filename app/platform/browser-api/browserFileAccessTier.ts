import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';

type TBrowserOpenFilePicker = (
    options?: {
        multiple?: boolean;
        excludeAcceptAllOption?: boolean;
        types?: IFilePickerAcceptType[];
    },
) => Promise<FileSystemFileHandle[]>;

type TBrowserSaveFilePicker = (
    options?: {
        suggestedName?: string;
        excludeAcceptAllOption?: boolean;
        types?: IFilePickerAcceptType[];
    },
) => Promise<FileSystemFileHandle>;

interface IWindowWithBrowserFilePickers extends Window {
    showOpenFilePicker?: TBrowserOpenFilePicker;
    showSaveFilePicker?: TBrowserSaveFilePicker;
}

/**
 * Browser file access degrades on two independent axes, so the tier is their
 * full product rather than an ordered ladder.
 */
export type TBrowserFileAccessTier =
    | 'file-system-access'
    | 'open-handle-only'
    | 'save-handle-only'
    | 'download-only';

interface IBrowserFileAccessTierSupport {
    /** Opening yields a handle the app can re-read and write back in place. */
    readonly opensWithHandle: boolean;
    /** Saving writes to a user-chosen target instead of an anchor download. */
    readonly savesToChosenTarget: boolean;
}

export const BROWSER_FILE_ACCESS_TIER_SUPPORT = {
    'file-system-access': {
        opensWithHandle: true,
        savesToChosenTarget: true,
    },
    'open-handle-only': {
        opensWithHandle: true,
        savesToChosenTarget: false,
    },
    'save-handle-only': {
        opensWithHandle: false,
        savesToChosenTarget: true,
    },
    'download-only': {
        opensWithHandle: false,
        savesToChosenTarget: false,
    },
} as const satisfies Record<TBrowserFileAccessTier, IBrowserFileAccessTierSupport>;

type TTierSupport = typeof BROWSER_FILE_ACCESS_TIER_SUPPORT;

/**
 * Generated from the support table so a tier cannot declare a capability it has
 * no command for: the tier discriminates which bound pickers the descriptor
 * carries, and consumers act on those instead of probing `window` again.
 */
export type TBrowserFileAccess = {
    [TTier in TBrowserFileAccessTier]: {
        tier: TTier;
        support: TTierSupport[TTier];
        openFilePicker: TTierSupport[TTier]['opensWithHandle'] extends true ? TBrowserOpenFilePicker : null;
        saveFilePicker: TTierSupport[TTier]['savesToChosenTarget'] extends true ? TBrowserSaveFilePicker : null;
    };
}[TBrowserFileAccessTier];

export function resolveBrowserFileAccess(): TBrowserFileAccess {
    const pickerWindow = typeof window === 'undefined'
        ? null
        : (window as IWindowWithBrowserFilePickers);
    const openFilePicker = typeof pickerWindow?.showOpenFilePicker === 'function'
        ? pickerWindow.showOpenFilePicker.bind(pickerWindow)
        : null;
    const saveFilePicker = typeof pickerWindow?.showSaveFilePicker === 'function'
        ? pickerWindow.showSaveFilePicker.bind(pickerWindow)
        : null;

    if (openFilePicker && saveFilePicker) {
        return {
            tier: 'file-system-access',
            support: BROWSER_FILE_ACCESS_TIER_SUPPORT['file-system-access'],
            openFilePicker,
            saveFilePicker,
        };
    }
    if (openFilePicker) {
        return {
            tier: 'open-handle-only',
            support: BROWSER_FILE_ACCESS_TIER_SUPPORT['open-handle-only'],
            openFilePicker,
            saveFilePicker: null,
        };
    }
    if (saveFilePicker) {
        return {
            tier: 'save-handle-only',
            support: BROWSER_FILE_ACCESS_TIER_SUPPORT['save-handle-only'],
            openFilePicker: null,
            saveFilePicker,
        };
    }

    return {
        tier: 'download-only',
        support: BROWSER_FILE_ACCESS_TIER_SUPPORT['download-only'],
        openFilePicker: null,
        saveFilePicker: null,
    };
}
