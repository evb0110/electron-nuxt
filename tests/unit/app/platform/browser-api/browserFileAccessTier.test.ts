import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_FILE_ACCESS_TIER_SUPPORT,
    resolveBrowserFileAccess,
} from '@app/platform/browser-api/browserFileAccessTier';
import type { TBrowserFileAccessTier } from '@app/platform/browser-api/browserFileAccessTier';

interface IPickerWindowShape {
    hasOpenPicker: boolean;
    hasSavePicker: boolean;
    tier: TBrowserFileAccessTier;
}

const PICKER_WINDOW_SHAPES: readonly IPickerWindowShape[] = [
    {
        hasOpenPicker: true,
        hasSavePicker: true,
        tier: 'file-system-access',
    },
    {
        hasOpenPicker: true,
        hasSavePicker: false,
        tier: 'open-handle-only',
    },
    {
        hasOpenPicker: false,
        hasSavePicker: true,
        tier: 'save-handle-only',
    },
    {
        hasOpenPicker: false,
        hasSavePicker: false,
        tier: 'download-only',
    },
];

function stubPickerWindow(shape: IPickerWindowShape) {
    const receivers: unknown[] = [];
    const pickerWindow = {
        ...(shape.hasOpenPicker
            ? {showOpenFilePicker(this: unknown) {
                receivers.push(this);
                return Promise.resolve([]);
            }}
            : {}),
        ...(shape.hasSavePicker
            ? {showSaveFilePicker(this: unknown) {
                receivers.push(this);
                return Promise.resolve({ name: 'picked.pdf' });
            }}
            : {}),
    };

    vi.stubGlobal('window', pickerWindow);
    return {
        pickerWindow,
        receivers,
    };
}

describe('browser file access tier', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('declares one tier per independent open and save combination', () => {
        expect(Object.keys(BROWSER_FILE_ACCESS_TIER_SUPPORT).sort())
            .toEqual(PICKER_WINDOW_SHAPES.map(shape => shape.tier).sort());

        const declaredSupport = Object.values(BROWSER_FILE_ACCESS_TIER_SUPPORT)
            .map(support => `${support.opensWithHandle}:${support.savesToChosenTarget}`);
        expect(new Set(declaredSupport).size).toBe(declaredSupport.length);
    });

    it('resolves each window shape to the tier whose declared support it can honor', () => {
        for (const shape of PICKER_WINDOW_SHAPES) {
            stubPickerWindow(shape);
            const access = resolveBrowserFileAccess();

            expect(access.tier).toBe(shape.tier);
            expect(access.support).toEqual(BROWSER_FILE_ACCESS_TIER_SUPPORT[shape.tier]);
            expect(access.support.opensWithHandle).toBe(access.openFilePicker !== null);
            expect(access.support.savesToChosenTarget).toBe(access.saveFilePicker !== null);
            expect(access.support.opensWithHandle).toBe(shape.hasOpenPicker);
            expect(access.support.savesToChosenTarget).toBe(shape.hasSavePicker);
        }
    });

    it('exposes picker commands already bound to the picker window', async () => {
        const {
            pickerWindow,
            receivers,
        } = stubPickerWindow({
            hasOpenPicker: true,
            hasSavePicker: true,
            tier: 'file-system-access',
        });
        const {
            openFilePicker,
            saveFilePicker,
        } = resolveBrowserFileAccess();

        await openFilePicker?.();
        await saveFilePicker?.();

        expect(receivers).toEqual([
            pickerWindow,
            pickerWindow,
        ]);
    });

    it('degrades to the download-only tier without a window', () => {
        vi.stubGlobal('window', undefined);
        const access = resolveBrowserFileAccess();

        expect(access.tier).toBe('download-only');
        expect(access.openFilePicker).toBeNull();
        expect(access.saveFilePicker).toBeNull();
    });
});
