import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertGithubActionsYamlSyntax,
    checkGithubActionsSyntax,
} from '@scripts/checkGithubActionsSyntax';

describe('GitHub Actions YAML syntax', () => {
    it('parses every checked-in workflow and composite action', async () => {
        const files = await checkGithubActionsSyntax();

        expect(files).toContain('.github/workflows/ci.yml');
        expect(files).toContain('.github/workflows/build.yml');
        expect(files).toContain('.github/actions/upload-electron-e2e-artifacts/action.yml');
    });

    it('reports the source location for an unquoted colon scalar regression', () => {
        expect(() => assertGithubActionsYamlSyntax([
            'name: Broken',
            'jobs:',
            '  check:',
            '    steps:',
            '      - run: command --only-binary=:all: -r requirements.txt',
        ].join('\n'), '.github/workflows/broken.yml')).toThrow(
            /\.github\/workflows\/broken\.yml:5:\d+:/u,
        );
    });
});
