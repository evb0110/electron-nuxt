import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readProjectFile(path: string) {
    return readFile(resolve(process.cwd(), path), 'utf8');
}

describe('OCR native and Electron journey policy', () => {
    it('keeps native OCR mandatory in nightly maintenance', async () => {
        const [
            packageJson,
            workflow,
        ] = await Promise.all([
            readProjectFile('package.json'),
            readProjectFile('.github/workflows/ci.yml'),
        ]);

        expect(packageJson).toContain(
            '"test:ocr:native-smoke:required": "EVB_OCR_NATIVE_SMOKE_REQUIRED=1 node scripts/test-ocr-native-smoke.mjs"',
        );
        expect(packageJson).toContain(
            '"test:ocr:quality:required": "EVB_OCR_QUALITY_REQUIRED=1 node scripts/test-ocr-quality-corpus.mjs"',
        );
        const nightlyMaintenance = workflow.slice(
            workflow.indexOf('  nightly_maintenance:'),
            workflow.indexOf('  nightly_electron_e2e_regression:'),
        );
        expect(nightlyMaintenance).toContain(
            'tesseract-ocr tesseract-ocr-eng poppler-utils',
        );
        expect(nightlyMaintenance).toContain(
            'run: pnpm run test:ocr:native-smoke:required',
        );
        expect(nightlyMaintenance).toContain(
            'run: pnpm run test:ocr:quality:required',
        );
    });

    it('keeps the real OCR Electron journey in the nightly quarantine project', async () => {
        const [
            sharedConfig,
            workflow,
        ] = await Promise.all([
            readProjectFile('vitest.shared.config.ts'),
            readProjectFile('.github/workflows/ci.yml'),
        ]);

        expect(sharedConfig).toContain(
            'const electronE2EQuarantineTestFiles = [\'tests/e2e/electron/quarantine/**/*.e2e.test.ts\']',
        );
        expect(workflow).toContain('run: pnpm run test:e2e:electron:quarantine');
        await expect(readProjectFile(
            'tests/e2e/electron/quarantine/ocrJourney.e2e.test.ts',
        )).resolves.toContain('describe(\'nightly OCR journey\'');
    });

    it('measures degraded corpus quality through the production OCR wrapper and searchable PDF', async () => {
        const [
            corpusGate,
            productionRunner,
        ] = await Promise.all([
            readProjectFile('scripts/test-ocr-quality-corpus.mjs'),
            readProjectFile('electron/ocr/worker/runProductionOcrQualityCase.ts'),
        ]);

        expect(productionRunner).toContain('runOcrFileBased(');
        expect(productionRunner).toContain('tryPreprocessOcrImage(');
        expect(productionRunner).toContain('qualityProfile: \'poor-scan\'');
        expect(productionRunner).toContain('pageSegmentationMode: 6');
        expect(corpusGate).toContain('runProductionOcrQualityCase({');
        expect(corpusGate).toContain('searchablePdfText');
        expect(corpusGate).toContain('pdfMetrics');
        expect(corpusGate).not.toMatch(/execFileAsync\(tesseract, \[\s*inputPath/u);
    });
});
