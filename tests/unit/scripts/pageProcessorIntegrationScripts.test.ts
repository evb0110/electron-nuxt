import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}

describe('page processor integration scripts', () => {
    it('keeps the smoke check covering core CLI integration surfaces', async () => {
        const smoke = await readProjectFile('scripts/check-page-processor-smoke.py');

        expect(smoke).toContain('"img2pdf>=0.6.3"');
        expect(smoke).toContain('"Pillow>=10.0.0"');
        expect(smoke).toContain('run_stage_and_padding_cli()');
        expect(smoke).toContain('run_pdf_cli()');
        expect(smoke).toContain('"detect",');
        expect(smoke).toContain('"apply",');
        expect(smoke).toContain('"pad",');
        expect(smoke).toContain('"img2pdf-pages",');
    });

    it('resolves devkit page-processor defaults from host platform and arch', async () => {
        const harness = await readProjectFile('scripts/devkit/page-processing-harness.py');
        const splitPad = await readProjectFile('scripts/devkit/process-pdf-split-pad.py');

        for (const script of [
            harness,
            splitPad,
        ]) {
            expect(script).toContain('import platform as host_platform');
            expect(script).toContain('def resolve_host_page_processing_tag()');
            expect(script).toContain('os.environ.get("EVB_PAGE_PROCESSOR")');
            expect(script).toContain('Path("resources/page-processing") / tag / "bin" / "page-processor" / f"page-processor{suffix}"');
            expect(script).not.toContain('default="resources/page-processing/darwin-arm64/bin/page-processor/page-processor"');
        }
    });

    it('makes the devkit harness fail when any recorded processor run fails', async () => {
        const harness = await readProjectFile('scripts/devkit/page-processing-harness.py');

        expect(harness).toContain('failure_count = 0');
        expect(harness).toContain('failure_count += 1');
        expect(harness).toContain('print(f"Failures: {failure_count}", file=sys.stderr)');
        expect(harness).toContain('return 1');
    });
});
