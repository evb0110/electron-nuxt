import {
    describe,
    expect,
    it,
} from 'vitest';
import { findCommonJsNamedImportViolations } from '@scripts/findCommonJsNamedImportViolations';

describe('checkCommonjsImports', () => {
    it('allows default, namespace, and type-only imports from guarded CommonJS packages', () => {
        const source = `
            import UTIF from 'utif';
            import * as UTIFNamespace from 'utif';
            import type { IUtifFrame } from 'utif';
            import UTIFDefault, { type IUtifImage } from 'utif';
        `;

        expect(findCommonJsNamedImportViolations('example.ts', source)).toEqual([]);
    });

    it('reports runtime named imports while ignoring type-only named specifiers', () => {
        const source = `
            import { decode, decodeImage as decodeImageAlias, type IUtifFrame } from 'utif';
        `;

        expect(findCommonJsNamedImportViolations('example.ts', source)).toMatchObject([{
            filePath: 'example.ts',
            importedNames: [
                'decode',
                'decodeImage',
            ],
            line: 2,
            packageName: 'utif',
        }]);
    });

    it('scans Vue SFC script blocks', () => {
        const source = `
            <template><div /></template>
            <script setup lang="ts">
            import { decode } from 'utif';
            </script>
        `;

        expect(findCommonJsNamedImportViolations('example.vue', source)).toMatchObject([{
            filePath: 'example.vue',
            importedNames: ['decode'],
            packageName: 'utif',
        }]);
    });
});
