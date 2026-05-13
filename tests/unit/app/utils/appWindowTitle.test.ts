import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    formatWebTitleTemplate,
    resolveAppWindowTitle,
} from '@app/utils/appWindowTitle';

describe('resolveAppWindowTitle', () => {
    it('falls back to the desktop app title when no document is open', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: null,
            isBrowserRuntime: false,
        })).toBe('EVB Viewer');
    });

    it('uses the active document name for desktop windows', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: ' notes.pdf ',
            isBrowserRuntime: false,
        })).toBe('notes.pdf');
    });

    it('falls back to the web app title when no document is open in the browser', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: null,
            isBrowserRuntime: true,
        })).toBe('EVB Viewer Web');
    });

    it('includes the active document name in browser window titles', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: 'notes.pdf',
            isBrowserRuntime: true,
        })).toBe('notes.pdf - EVB Viewer Web');
    });
});

describe('formatWebTitleTemplate', () => {
    it('avoids duplicating the app name when the page title already matches it', () => {
        expect(formatWebTitleTemplate('EVB Viewer Web', 'EVB Viewer Web')).toBe('EVB Viewer Web');
    });

    it('appends the app name for distinct page titles', () => {
        expect(formatWebTitleTemplate('Download', 'EVB Viewer Web')).toBe('Download — EVB Viewer Web');
    });
});
