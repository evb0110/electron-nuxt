import {
    readdirSync,
    readFileSync,
} from 'node:fs';
import {
    extname,
    join,
    relative,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ILayoutTokenPolicyCounts {
    dimensions: number;
    fontSizes: number;
    zIndexes: number;
    arbitraryTailwind: number;
}

const APP_ROOT = resolve(process.cwd(), 'app');
const SOURCE_EXTENSIONS = new Set([
    '.css',
    '.scss',
    '.vue',
]);

const EXCLUDED_SOURCE_FILES = new Set(['assets/css/main.css']);

const RAW_PATTERNS = {
    dimensions: /(?:^|[;{\s])(?:width|height|min-width|max-width|min-height|max-height|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|padding(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|margin(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|top|right|bottom|left|inset(?:-(?:inline|block)(?:-(?:start|end))?)?|border-radius)\s*:\s*-?(?!0(?:\.0+)?(?:\D|$))\d*\.?\d+(?:px|rem|em)\b/gmu,
    fontSizes: /font-size\s*:\s*\d*\.?\d+(?:px|rem|em)\b/gu,
    zIndexes: /z-index\s*:\s*-?\d+\b/gu,
    arbitraryTailwind: /\b(?:[a-z-]+:)*[a-z-]+-\[\s*-?\d[^\]\n]*\]/gu,
} as const;

export const LAYOUT_TOKEN_POLICY_MAXIMUMS: ILayoutTokenPolicyCounts = {
    dimensions: 0,
    fontSizes: 0,
    zIndexes: 0,
    arbitraryTailwind: 0,
};

export function isLayoutTokenPolicySourceExcluded(relativePath: string) {
    return relativePath.startsWith('assets/css/vendor/')
        || EXCLUDED_SOURCE_FILES.has(relativePath);
}

function listSourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return listSourceFiles(path);
        }
        return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    });
}

export function getLayoutTokenPolicySourceFiles() {
    return listSourceFiles(APP_ROOT)
        .filter(path => !isLayoutTokenPolicySourceExcluded(relative(APP_ROOT, path)))
        .sort();
}

export function countLayoutTokenPolicyDebt(
    files = getLayoutTokenPolicySourceFiles(),
): ILayoutTokenPolicyCounts {
    const counts: ILayoutTokenPolicyCounts = {
        dimensions: 0,
        fontSizes: 0,
        zIndexes: 0,
        arbitraryTailwind: 0,
    };

    for (const path of files) {
        const source = readFileSync(path, 'utf8');
        for (const category of Object.keys(RAW_PATTERNS) as Array<keyof ILayoutTokenPolicyCounts>) {
            counts[category] += source.match(RAW_PATTERNS[category])?.length ?? 0;
        }
    }
    return counts;
}

export function assertLayoutTokenPolicy(
    counts = countLayoutTokenPolicyDebt(),
    maximums = LAYOUT_TOKEN_POLICY_MAXIMUMS,
) {
    const violations = (Object.keys(maximums) as Array<keyof ILayoutTokenPolicyCounts>)
        .filter(category => counts[category] > maximums[category])
        .map(category => `${category}: ${counts[category]} > ${maximums[category]}`);
    if (violations.length > 0) {
        throw new Error(`Application chrome layout-token debt increased:\n${violations.join('\n')}`);
    }
}

const isDirectExecution = process.argv[1]
    ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
if (isDirectExecution) {
    const counts = countLayoutTokenPolicyDebt();
    assertLayoutTokenPolicy(counts);
    process.stdout.write(`Layout token policy passed: ${JSON.stringify(counts)}\n`);
}
