import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    COMPUTER_TOOLSET_MEMBERS,
    COMPUTER_TOOLSET_NAME,
    COMPUTER_TOOLSET_TYPE,
    SEMANTIC_TOOLS,
    SHARED_TOOLS,
    buildOperatorSystemPrompt,
    buildOperatorTaskCard,
    buildOperatorToolDefinitions,
    isComputerToolsetMember,
} from '@scripts/stress/stressOperatorToolSchemas';

describe('stress operator tool schemas', () => {
    it('lists the seventeen computer toolset members once each', () => {
        expect(COMPUTER_TOOLSET_MEMBERS).toHaveLength(17);
        expect(new Set(COMPUTER_TOOLSET_MEMBERS).size).toBe(17);
        expect(isComputerToolsetMember('screenshot')).toBe(true);
        expect(isComputerToolsetMember('open_document')).toBe(false);
        expect(COMPUTER_TOOLSET_TYPE).toBe('computer_toolset_20260801');
        expect(COMPUTER_TOOLSET_NAME).toBe('computer');
    });

    it('gives the pixel profile only the shared tools and the semantic profile the DOM tools too', () => {
        const pixel = buildOperatorToolDefinitions('pixel').map(tool => tool.name);
        const semantic = buildOperatorToolDefinitions('semantic').map(tool => tool.name);
        expect(pixel).toEqual(SHARED_TOOLS.map(tool => tool.name));
        expect(semantic).toEqual([
            ...SEMANTIC_TOOLS.map(tool => tool.name),
            ...SHARED_TOOLS.map(tool => tool.name),
        ]);
        expect(pixel).toContain('report');
        expect(semantic).toContain('observe');
        expect(new Set(semantic).size).toBe(semantic.length);
    });

    it('declares closed input schemas with required fields', () => {
        for (const tool of [
            ...SHARED_TOOLS,
            ...SEMANTIC_TOOLS,
        ]) {
            expect(tool.input_schema.type).toBe('object');
            expect(tool.input_schema.additionalProperties).toBe(false);
            for (const required of tool.input_schema.required ?? []) {
                expect(Object.keys(tool.input_schema.properties)).toContain(required);
            }
        }
    });

    it('interpolates the turn budget into the system prompt and names the profile', () => {
        const pixel = buildOperatorSystemPrompt('pixel', 25);
        expect(pixel).toContain('at most 25 turns');
        expect(pixel).toContain('at most 4 tool calls');
        expect(pixel).not.toContain('{{MAX_TURNS}}');
        expect(pixel).not.toContain('{{MAX_TOOL_CALLS}}');
        expect(pixel).toContain('repeats 3 times');
        expect(pixel).not.toContain('{{FREEZE_STREAK}}');
        expect(buildOperatorSystemPrompt('pixel', 25, 2)).toContain('at most 2 tool calls');
        expect(pixel).toContain('screenshots');
        expect(buildOperatorSystemPrompt('semantic', 10)).toContain('observe');
    });

    it('writes a task card with numbered files, steps and prohibitions', () => {
        const card = buildOperatorTaskCard('tab-storm', {
            goal: 'Open many tabs',
            steps: [
                'Open the first file',
                'Open the second file in a new tab',
            ],
            pace: 'fast',
            doneWhen: 'both tabs are open',
            doNot: ['Do not save'],
        }, [
            '/tmp/a.pdf',
            '/tmp/b.pdf',
        ], 30);
        expect(card).toContain('TASK tab-storm');
        expect(card).toContain('  1. /tmp/a.pdf');
        expect(card).toContain('  2. Open the second file in a new tab');
        expect(card).toContain('Budget: 30 turns.');
        expect(card).toContain('  - Do not save');
    });
});
