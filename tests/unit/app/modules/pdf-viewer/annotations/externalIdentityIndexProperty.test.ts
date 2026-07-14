import {
    describe,
    expect,
    it,
} from 'vitest';
import fc from 'fast-check';
import {
    ExternalIdentityConflictError,
    ExternalIdentityIndex,
} from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {
    asAnnotationId,
    deriveAnnotationId,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';

const nonBlankString = fc.string({
    minLength: 1,
    maxLength: 64,
})
    .filter(value => value.trim().length > 0);
const normalizedNonBlankString = nonBlankString.map(value => value.trim());

describe('ExternalIdentityIndex properties', () => {
    it('derives the same canonical id independently of geometry jitter', () => {
        fc.assert(fc.property(
            nonBlankString,
            nonBlankString,
            fc.record({
                left: fc.double({
                    min: 0,
                    max: 1,
                    noNaN: true,
                }),
                top: fc.double({
                    min: 0,
                    max: 1,
                    noNaN: true,
                }),
                width: fc.double({
                    min: 0,
                    max: 0.02,
                    noNaN: true,
                }),
                height: fc.double({
                    min: 0,
                    max: 0.02,
                    noNaN: true,
                }),
            }),
            (documentKey, persistentIdentity, geometry) => {
                const before = deriveAnnotationId(documentKey, persistentIdentity);
                const after = deriveAnnotationId(documentKey, persistentIdentity);
                expect({
                    before,
                    after,
                    geometry,
                }).toMatchObject({before: after});
            },
        ));
    });

    it('resolves every explicit binding idempotently and never from proximity or text', () => {
        fc.assert(fc.property(
            fc.uniqueArray(nonBlankString, {
                minLength: 5,
                maxLength: 5,
            }),
            (values) => {
                const [
                    idValue,
                    pdfRef,
                    pdfName,
                    pdfjsUid,
                    elementId,
                ] = values as [string, string, string, string, string];
                const id = asAnnotationId(idValue);
                const index = new ExternalIdentityIndex();
                index.bind({
                    id,
                    pdfRef,
                    pdfName,
                    pdfjsUid,
                    elementId,
                });

                expect(index.resolve({pdfRef})).toBe(id);
                expect(index.resolve({pdfName})).toBe(id);
                expect(index.resolve({pdfjsUid})).toBe(id);
                expect(index.resolve({elementId})).toBe(id);
                expect(index.resolve({})).toBeNull();
                expect(index.resolve(castUnknownBindings({
                    pageIndex: 10,
                    text: pdfName,
                    rect: {
                        left: 0.1,
                        top: 0.1,
                        width: 0.01,
                        height: 0.01,
                    },
                }))).toBeNull();
            },
        ));
    });

    it('never merges two annotations that claim the same external identity', () => {
        fc.assert(fc.property(
            nonBlankString,
            nonBlankString,
            nonBlankString,
            (firstIdValue, secondIdValue, pdfName) => {
                fc.pre(firstIdValue.trim() !== secondIdValue.trim());
                const index = new ExternalIdentityIndex();
                index.bind({
                    id: asAnnotationId(firstIdValue),
                    pdfName,
                });

                expect(() => index.bind({
                    id: asAnnotationId(secondIdValue),
                    pdfName,
                }))
                    .toThrow(ExternalIdentityConflictError);
            },
        ));
    });

    it('rejects a lookup whose explicit bindings point at different annotations', () => {
        fc.assert(fc.property(
            fc.uniqueArray(normalizedNonBlankString, {
                minLength: 4,
                maxLength: 4,
            }),
            (values) => {
                const [
                    firstId,
                    secondId,
                    pdfRef,
                    pdfName,
                ] = values as [string, string, string, string];
                const index = new ExternalIdentityIndex();
                index.bind({
                    id: asAnnotationId(firstId),
                    pdfRef,
                });
                index.bind({
                    id: asAnnotationId(secondId),
                    pdfName,
                });

                expect(() => index.resolve({
                    pdfRef,
                    pdfName,
                }))
                    .toThrow(ExternalIdentityConflictError);
            },
        ));
    });

    it('treats whitespace-equivalent annotation ids as the same owner', () => {
        const index = new ExternalIdentityIndex();
        index.bind({
            id: asAnnotationId(' !'),
            pdfRef: 'ref',
        });
        index.bind({
            id: asAnnotationId('!'),
            pdfName: 'name',
        });

        expect(index.resolve({
            pdfRef: 'ref',
            pdfName: 'name',
        })).toBe(asAnnotationId('!'));
    });
});

function castUnknownBindings(value: object) {
    return value as Parameters<ExternalIdentityIndex['resolve']>[0];
}
