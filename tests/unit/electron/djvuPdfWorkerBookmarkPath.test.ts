import { readFile } from 'fs/promises';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('DjVu PDF worker bookmark path', () => {
    it('routes bookmark embedding through the native-first helper instead of direct pdf-lib rewrite', async () => {
        const source = await readFile(
            join(process.cwd(), 'electron/features/djvu/main/pdfWorker.ts'),
            'utf8',
        );

        expect(source).toContain('embedBookmarksIntoPdfFile');
        expect(source).toContain('@electron/djvu/embedBookmarksIntoPdfFile');
        expect(source).not.toContain('embedBookmarksIntoPdfFileWithPdfLib');
    });
});
