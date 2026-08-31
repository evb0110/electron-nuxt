import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createDupesBaseline,
    createStableCloneSignature,
    decodeDupesBaseline,
    findNewCloneGroups,
} from '@scripts/architecture/dupesRegressionPolicy.mjs';

function cloneGroup(fragment = 'const value = source.value;') {
    return {instances: [
        {
            file: 'app/first.ts',
            start_line: 10,
            end_line: 20,
            fragment,
        },
        {
            file: 'app/second.ts',
            start_line: 30,
            end_line: 40,
            fragment,
        },
    ]};
}

describe('duplication regression policy', () => {
    it('keeps clone identity stable when only source line positions change', () => {
        const original = cloneGroup();
        const moved = cloneGroup();
        moved.instances[0]!.start_line = 110;
        moved.instances[0]!.end_line = 120;

        expect(createStableCloneSignature(moved)).toBe(createStableCloneSignature(original));
        expect(findNewCloneGroups(
            {clone_groups: [moved]},
            createDupesBaseline({clone_groups: [original]}),
        )).toEqual([]);
    });

    it('reports a clone when its duplicated source changes', () => {
        const accepted = cloneGroup();
        const changed = cloneGroup('const value = source.otherValue;');

        expect(findNewCloneGroups(
            {clone_groups: [changed]},
            createDupesBaseline({clone_groups: [accepted]}),
        )).toEqual([changed]);
    });

    it('rejects malformed or duplicate baseline signatures', () => {
        expect(() => decodeDupesBaseline({
            schema_version: 1,
            clone_signatures: ['dup:c77b3abb6f87acd9-1:2'],
        })).toThrow('stable clone signatures');

        const signature = createStableCloneSignature(cloneGroup());
        expect(() => decodeDupesBaseline({
            schema_version: 1,
            clone_signatures: [
                signature,
                signature,
            ],
        })).toThrow('must be unique');
    });
});
