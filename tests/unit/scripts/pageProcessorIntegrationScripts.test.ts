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

        expect(smoke).toContain('LOCK_PATH = PAGE_PROCESSOR_ROOT / "requirements-lock.txt"');
        expect(smoke).toContain('"--require-hashes"');
        expect(smoke).toContain('"--only-binary=:all:"');
        expect(smoke).toContain('run_python_quality_gates()');
        expect(smoke).toContain('run_stage_and_padding_cli()');
        expect(smoke).toContain('run_pdf_cli()');
        expect(smoke).toContain('run_real_locked_dewarp_cli()');
        expect(smoke).toContain('run_resource_and_transaction_regressions()');
        expect(smoke).toContain('run_ocr_benchmark_regressions()');
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
            expect(script).toContain('PROJECT_ROOT = Path(__file__).resolve().parents[2]');
            expect(script).toContain('def resolve_host_page_processing_tag()');
            expect(script).toContain('os.environ.get("EVB_PAGE_PROCESSOR")');
            expect(script).toContain('PROJECT_ROOT / "resources/page-processing" / tag / "bin" / "page-processor" / f"page-processor{suffix}"');
            expect(script).not.toContain('default="resources/page-processing/darwin-arm64/bin/page-processor/page-processor"');
        }

        expect(harness).toContain('PROJECT_ROOT / ".devkit/tmp/pp-harness"');
        expect(splitPad).toContain('PROJECT_ROOT / ".devkit/tmp/pdf-split-pad"');
    });

    it('makes the devkit harness fail when any recorded processor run fails', async () => {
        const harness = await readProjectFile('scripts/devkit/page-processing-harness.py');

        expect(harness).toContain('failure_count = 0');
        expect(harness).toContain('failure_count += 1');
        expect(harness).toContain('print(f"Failures: {failure_count}", file=sys.stderr)');
        expect(harness).toContain('return 1');
    });

    it('preserves devkit processor logs on failures and timeouts', async () => {
        const harness = await readProjectFile('scripts/devkit/page-processing-harness.py');
        const splitPad = await readProjectFile('scripts/devkit/process-pdf-split-pad.py');

        for (const script of [
            harness,
            splitPad,
        ]) {
            expect(script).toContain('import shlex');
            expect(script).toContain('def output_text(value: str | bytes | None) -> str:');
            expect(script).toContain('except subprocess.TimeoutExpired as e:');
            expect(script).toContain('(out_dir / "stdout.log").write_text(output_text(e.stdout), encoding="utf-8")');
            expect(script).toContain('(out_dir / "stderr.log").write_text(output_text(e.stderr), encoding="utf-8")');
            expect(script).toContain('(out_dir / "timeout.log").write_text(');
            expect(script).toContain('page-processor exited {proc.returncode}; logs: {out_dir}');
            expect(script).toContain('timeout=timeout_s');
        }

        expect(harness).toContain('ap.add_argument("--timeout", type=int, default=300');
    });
});
