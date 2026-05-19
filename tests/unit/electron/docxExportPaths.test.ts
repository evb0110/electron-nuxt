import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'path';
import {
    allowDocxWritePath,
    consumeAllowedDocxWritePath,
    normalizeDocxPath,
} from '@electron/ipc/docxExportPaths';

describe('docxExportPaths', () => {
    it('allows consuming a path that was provided by save dialog', () => {
        const filePath = './tmp-test-export.docx';
        const absolutePath = resolve(filePath);

        allowDocxWritePath(filePath, 10);

        expect(consumeAllowedDocxWritePath(absolutePath, 10)).toBe(true);
        expect(consumeAllowedDocxWritePath(absolutePath, 10)).toBe(false);
    });

    it('rejects consuming a grant from a different sender', () => {
        const filePath = './tmp-cross-sender-export.docx';
        const absolutePath = resolve(filePath);

        allowDocxWritePath(filePath, 10);

        expect(consumeAllowedDocxWritePath(absolutePath, 11)).toBe(false);
        expect(consumeAllowedDocxWritePath(absolutePath, 10)).toBe(true);
    });

    it('rejects paths that were never allowed', () => {
        const filePath = resolve('./tmp-never-allowed.docx');
        expect(consumeAllowedDocxWritePath(filePath, 10)).toBe(false);
    });

    it('validates docx extension', () => {
        expect(() => normalizeDocxPath('report.txt')).toThrow('Invalid file type: only DOCX files are allowed');
    });
});
