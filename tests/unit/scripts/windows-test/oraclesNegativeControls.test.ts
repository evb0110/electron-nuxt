import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { generateNegativeControls } from '@scripts/windows-test/fixtures/generateNegativeControls';
import {
    NUMBERED_FIXTURE_PAGE_COUNT,
    generateNumberedFixture,
    numberedFixtureMarkers,
} from '@scripts/windows-test/fixtures/generateNumberedFixture';
import type { TOracleStatus } from '@scripts/windows-test/oracles/oracleResult';
import { combineOracleStatuses } from '@scripts/windows-test/oracles/oracleResult';
import { evaluatePageMarkers } from '@scripts/windows-test/oracles/pageMarkerOracle';
import {
    evaluatePageCount,
    evaluatePdfStructure,
    inspectPdfStructure,
} from '@scripts/windows-test/oracles/pdfStructureOracle';
import { evaluateRenderNonBlank } from '@scripts/windows-test/oracles/renderBlankOracle';

const repositoryRoot = process.cwd();

interface ISubject {
    name: string;
    bytes: Uint8Array;
}

let good: Uint8Array;
let blank: Uint8Array;
let wrongMarkers: Uint8Array;
let truncated: Uint8Array;
let expectedTitle: string;

beforeAll(async () => {
    good = await generateNumberedFixture();
    const controls = await generateNegativeControls();
    blank = controls.blankSinglePage;
    wrongMarkers = controls.wrongPageMarkers;
    truncated = controls.truncated;
    const structure = await inspectPdfStructure(good);
    expect(structure.title).toBeTypeOf('string');
    expectedTitle = structure.title ?? '';
});

async function runOracleSet(bytes: Uint8Array) {
    return {
        pageCount: await evaluatePageCount(bytes, NUMBERED_FIXTURE_PAGE_COUNT),
        structure: await evaluatePdfStructure(bytes, {
            pageCount: NUMBERED_FIXTURE_PAGE_COUNT,
            title: expectedTitle,
        }),
        pageMarkers: await evaluatePageMarkers(bytes, {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
        }),
        render: await evaluateRenderNonBlank(bytes, { repositoryRoot }),
    };
}

describe('the good F01 fixture', () => {
    it('is accepted by every host oracle', async () => {
        const results = await runOracleSet(good);
        for (const [
            name,
            result,
        ] of Object.entries(results)) {
            expect(result.status, `${name}: ${result.detail}`).toBe('passed');
            expect(result.oracleVersion.length).toBeGreaterThan(0);
        }
    });
});

describe('the blank negative control', () => {
    it('is rejected by the render, marker, page-count and structure oracles', async () => {
        const results = await runOracleSet(blank);
        expect(results.render.status).toBe('failed');
        expect(results.render.detail).toContain('non-white ratio');
        expect(results.pageMarkers.status).toBe('failed');
        expect(results.pageCount.status).toBe('failed');
        expect(results.structure.status).toBe('failed');
    });
});

describe('the wrong-page-marker negative control', () => {
    it('is rejected by the marker oracle and by the structure identity check', async () => {
        const results = await runOracleSet(wrongMarkers);
        expect(results.pageMarkers.status).toBe('failed');
        expect(results.pageMarkers.detail).toContain('does not carry');
        expect(results.structure.status).toBe('failed');
        expect(results.structure.detail).toContain('title is');
    });

    it('is rejected when the forbidden markers of another page are named', async () => {
        const result = await evaluatePageMarkers(wrongMarkers, {
            repositoryRoot,
            expectedMarkers: numberedFixtureMarkers(),
            forbiddenMarkers: ['EVB-F01-PAGE-03'],
        });
        expect(result.status).toBe('failed');
    });

    it('is not the render oracle\'s job to catch, so the pack verdict still fails', async () => {
        // The control is deliberately non-blank: it carries the right amount of
        // ink on every page and only the marker text is rotated. Blankness
        // cannot see that, so the marker oracle owns this control and the
        // combined pack verdict is what must stay red.
        const results = await runOracleSet(wrongMarkers);
        expect(results.render.status).toBe('passed');
        const statuses: TOracleStatus[] = Object.values(results).map(result => result.status);
        expect(combineOracleStatuses(statuses)).toBe('failed');
    });
});

describe('the truncated negative control', () => {
    it('is rejected by every oracle that has to parse it', async () => {
        const results = await runOracleSet(truncated);
        expect(results.pageCount.status).toBe('failed');
        expect(results.structure.status).toBe('failed');
        expect(results.pageMarkers.status).toBe('failed');
        expect(results.render.status).toBe('failed');
    });
});

describe('the negative control matrix', () => {
    it('leaves no control accepted by the whole oracle set', async () => {
        const subjects: ISubject[] = [
            {
                name: 'blank',
                bytes: blank,
            },
            {
                name: 'wrong-markers',
                bytes: wrongMarkers,
            },
            {
                name: 'truncated',
                bytes: truncated,
            },
        ];
        for (const subject of subjects) {
            const results = await runOracleSet(subject.bytes);
            const statuses: TOracleStatus[] = Object.values(results).map(result => result.status);
            expect(combineOracleStatuses(statuses), subject.name).toBe('failed');
        }
    });
});

describe('page geometry and annotation expectations', () => {
    it('reports a geometry mismatch, a rotation mismatch and a subject mismatch', async () => {
        const wrongGeometry = await evaluatePdfStructure(good, {pageGeometry: Array.from({ length: NUMBERED_FIXTURE_PAGE_COUNT }, () => ({
            width: 612,
            height: 792,
            rotation: 90,
        }))});
        expect(wrongGeometry.status).toBe('failed');
        expect(wrongGeometry.detail).toContain('rotation is 0');
        const shortList = await evaluatePdfStructure(good, {pageGeometry: [{
            width: 595.28,
            height: 841.89,
            rotation: 0,
        }]});
        expect(shortList.detail).toContain('geometry list covers 1 pages');
        const wrongSubject = await evaluatePdfStructure(good, { subject: 'nope' });
        expect(wrongSubject.status).toBe('failed');
        const wrongAnnotations = await evaluatePdfStructure(good, { annotationCount: 99 });
        expect(wrongAnnotations.status).toBe('failed');
    });

    it('does not pass an expectation that asserts nothing', async () => {
        const empty = await evaluatePdfStructure(good, {});
        expect(empty.status).toBe('inconclusive');
    });
});
