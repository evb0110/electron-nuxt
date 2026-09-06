import {
    describe,
    expect,
    it,
} from 'vitest';
import { runtimeSchema } from '@contracts/platformFeature';

const s = runtimeSchema;

describe('runtimeSchema failure paths', () => {
    const pageSchema = s.object({
        rule: s.string(),
        widthPx: s.number({
            integer: true,
            min: 1,
        }),
    });
    const documentSchema = s.object({
        title: s.string(),
        pages: s.array(pageSchema),
        labels: s.record(s.boolean()),
        cover: s.optional(pageSchema),
        parent: s.nullable(s.string()),
    });

    it('names the failing field inside nested arrays and objects', () => {
        expect(() => documentSchema.decode({
            title: 'doc',
            pages: [
                {
                    rule: 'a',
                    widthPx: 1,
                },
                {
                    rule: 'b',
                    widthPx: 1,
                },
                {
                    rule: 'c',
                    widthPx: 1,
                },
                {
                    rule: 42,
                    widthPx: 1,
                },
            ],
            labels: {},
            parent: null,
        })).toThrow('pages[3].rule: expected a string');
    });

    it('reports top-level fields without a path prefix', () => {
        expect(() => documentSchema.decode({
            title: 7,
            pages: [],
            labels: {},
            parent: null,
        })).toThrow(/^title: expected a string$/u);
        expect(() => s.string().decode(7)).toThrow(/^expected a string$/u);
    });

    it('quotes record keys that are not identifiers', () => {
        expect(() => documentSchema.decode({
            title: 'doc',
            pages: [],
            labels: { 'has space': 'yes' },
            parent: null,
        })).toThrow('labels["has space"]: expected a boolean IPC result');
    });

    it('threads the path through optional, nullable, and refine wrappers', () => {
        expect(() => documentSchema.decode({
            title: 'doc',
            pages: [],
            labels: {},
            cover: {
                rule: 'x',
                widthPx: 0,
            },
            parent: null,
        })).toThrow('cover.widthPx: expected a finite number');
        expect(() => documentSchema.decode({
            title: 'doc',
            pages: [],
            labels: {},
            parent: 12,
        })).toThrow('parent: expected a string');

        const positive = s.object({ count: s.refine(s.number(), value => value > 0, 'expected a positive count') });
        expect(() => positive.decode({ count: 0 })).toThrow('count: expected a positive count');
    });

    it('prefixes parser errors once and never doubles an existing prefix', () => {
        const parsed = s.object({ inner: s.object({ value: s.fromParser((value: unknown) => {
            if (typeof value !== 'string') {
                throw new Error('custom parser rejected value');
            }
            return value;
        }, () => '') }) });
        expect(() => parsed.decode({ inner: { value: 1 } })).toThrow(/^inner\.value: custom parser rejected value$/u);

        const outer = s.object({ inner: s.object({ value: s.string() }) });
        expect(() => outer.decode({ inner: { value: 1 } })).toThrow(/^inner\.value: expected a string$/u);
    });

    it('reports tuple arity at the tuple position', () => {
        const args = s.tuple([
            s.string(),
            s.number(),
        ] as const);
        expect(() => args.decode(['only'])).toThrow(/^expected 2 arguments, received 1$/u);
        expect(() => args.decode([
            'ok',
            'not-a-number',
        ])).toThrow('[1]: expected a finite number');

        const wrapped = s.object({ args });
        expect(() => wrapped.decode({ args: [] })).toThrow('args: expected 2 arguments, received 0');
    });
});
