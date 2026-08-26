import {
    access,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function pathExists(filePath: string) {
    try {
        await access(filePath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

const RETIRED_REVIEWER_PATTERN = /cubic|Ox Alpha|pi-subagent|review-cubic-commits/iu;
const REQUIRED_REVIEW_POLICY_PATTERN = /after normal gates and before committing\s+or pushing, run CodeRabbit CLI\s+locally against `main`\./iu;

describe('independent reviewer policy', () => {
    it.each([
        'AGENTS.md',
        'CLAUDE.md',
    ])('keeps CodeRabbit as the only required reviewer in %s', async (fileName) => {
        const policy = await readFile(path.join(process.cwd(), fileName), 'utf8');

        expect(policy).toMatch(REQUIRED_REVIEW_POLICY_PATTERN);
        expect(policy).not.toMatch(RETIRED_REVIEWER_PATTERN);
    });

    it.each([
        '.husky/pre-push',
        'package.json',
    ])('keeps retired reviewer commands out of %s', async (fileName) => {
        const integration = await readFile(path.join(process.cwd(), fileName), 'utf8');

        expect(integration).not.toMatch(RETIRED_REVIEWER_PATTERN);
    });

    it('does not ship the retired Cubic integration', async () => {
        await expect(pathExists(path.join(process.cwd(), 'cubic.yaml'))).resolves.toBe(false);
        await expect(pathExists(path.join(
            process.cwd(),
            'scripts',
            'review-cubic-commits.mjs',
        ))).resolves.toBe(false);
    });
});
