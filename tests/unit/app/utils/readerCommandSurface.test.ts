import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DESKTOP_EDITOR_READER_COMMAND_SURFACE,
    MOBILE_READER_COMMAND_SURFACE,
    isReaderCommandInMenu,
    isReaderCommandInline,
    listReaderCommandsForPlacement,
} from '@app/utils/readerCommandSurface';

describe('readerCommandSurface', () => {
    it('keeps desktop editor tools inline while routing file-only actions through menus', () => {
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'open-file')).toBe(false);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'open-file')).toBe(true);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'print-current-page')).toBe(false);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'print-current-page')).toBe(true);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'capture-region')).toBe(true);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'crop')).toBe(true);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'capture-region')).toBe(true);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'crop')).toBe(true);
    });

    it('keeps mobile chrome compact while exposing document commands through the host menu', () => {
        expect(isReaderCommandInline(MOBILE_READER_COMMAND_SURFACE, 'open-file')).toBe(true);
        expect(isReaderCommandInline(MOBILE_READER_COMMAND_SURFACE, 'page-navigation')).toBe(true);
        expect(isReaderCommandInline(MOBILE_READER_COMMAND_SURFACE, 'zoom')).toBe(true);
        expect(isReaderCommandInline(MOBILE_READER_COMMAND_SURFACE, 'crop')).toBe(false);
        expect(isReaderCommandInline(MOBILE_READER_COMMAND_SURFACE, 'quick-note')).toBe(false);

        expect(isReaderCommandInMenu(MOBILE_READER_COMMAND_SURFACE, 'crop')).toBe(true);
        expect(isReaderCommandInMenu(MOBILE_READER_COMMAND_SURFACE, 'quick-note')).toBe(true);
        expect(isReaderCommandInMenu(MOBILE_READER_COMMAND_SURFACE, 'export-docx')).toBe(true);
    });

    it('lists commands by placement for host renderers', () => {
        expect(listReaderCommandsForPlacement(MOBILE_READER_COMMAND_SURFACE, 'inline')).toEqual([
            'app-menu',
            'open-file',
            'overflow-menu',
            'page-navigation',
            'zoom',
        ]);

        expect(listReaderCommandsForPlacement(MOBILE_READER_COMMAND_SURFACE, 'menu')).toContain('settings');
    });
});
