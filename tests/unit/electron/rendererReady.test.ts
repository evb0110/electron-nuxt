import {
    describe,
    expect,
    it,
} from 'vitest';
import type { BrowserWindow } from 'electron';
import {
    resolveExternalOpenDispatchWindow,
    shouldResetRendererReadyOnNavigation,
} from '@electron/bootstrap/rendererReady';

describe('renderer ready helpers', () => {
    it('keeps the renderer marked ready during in-place navigation', () => {
        expect(shouldResetRendererReadyOnNavigation({
            isMainFrame: true,
            isInPlace: true,
        })).toBe(false);
    });

    it('resets the renderer ready state for full main-frame navigations', () => {
        expect(shouldResetRendererReadyOnNavigation({
            isMainFrame: true,
            isInPlace: false,
        })).toBe(true);
    });

    it('ignores subframe navigations when deciding renderer readiness', () => {
        expect(shouldResetRendererReadyOnNavigation({
            isMainFrame: false,
            isInPlace: false,
        })).toBe(false);
    });

    it('prefers the main window for externalOpen dispatch even when another window is focused', () => {
        const mainWindow = {} as BrowserWindow;
        const focusedWindow = {} as BrowserWindow;

        expect(resolveExternalOpenDispatchWindow({
            mainWindow,
            focusedWindow,
        })).toBe(mainWindow);
    });

    it('falls back to the focused window when no main window is registered', () => {
        const focusedWindow = {} as BrowserWindow;

        expect(resolveExternalOpenDispatchWindow({
            mainWindow: null,
            focusedWindow,
        })).toBe(focusedWindow);
    });
});
