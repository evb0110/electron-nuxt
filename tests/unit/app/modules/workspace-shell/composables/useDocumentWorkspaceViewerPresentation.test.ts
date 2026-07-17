import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldShowDjvuConversionBanner } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation';

describe('shouldShowDjvuConversionBanner', () => {
    const readyPresentation = {
        conversionUiAvailable: true,
        documentOpenReady: true,
        initialDocumentVisualReady: true,
        showDjvuBanner: true,
        showDjvuSource: true,
    };

    it('waits for the active DjVu source to make a durable initial visual commit', () => {
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            documentOpenReady: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            initialDocumentVisualReady: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            showDjvuSource: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner(readyPresentation)).toBe(true);
    });

    it('does not revive an unavailable or dismissed conversion notice', () => {
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            conversionUiAvailable: false,
        })).toBe(false);
        expect(shouldShowDjvuConversionBanner({
            ...readyPresentation,
            showDjvuBanner: false,
        })).toBe(false);
    });
});
