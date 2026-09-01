import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ITypeCoverageProject {id: string;}
interface ITypeCoverageRunResult {
    id: string;
    status: number;
}
interface ITypeCoverageModule {checkTypeCoverage: (
    runner: (project: ITypeCoverageProject) => Promise<ITypeCoverageRunResult>,
) => Promise<ITypeCoverageRunResult[]>;}

const typeCoverage = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/checkTypeCoverage.ts'),
).href) as ITypeCoverageModule;

describe('type coverage orchestration', () => {
    it('starts all independent project checks without waiting for the previous project', async () => {
        const started: string[] = [];
        const results = await typeCoverage.checkTypeCoverage(async project => {
            started.push(project.id);
            await new Promise(resolve => setTimeout(resolve, 5));
            return {
                id: project.id,
                status: 0,
            };
        });

        expect(started).toEqual([
            'app',
            'electron',
            'tests',
            'scripts',
        ]);
        expect(results.map(result => result.id)).toEqual(started);
    });
});
