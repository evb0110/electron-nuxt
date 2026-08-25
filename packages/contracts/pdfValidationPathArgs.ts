import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfPathValidationOptions } from '@contracts/electronApiDocuments';
import {runtimeSchema as s} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';

type TPdfValidationPathArgs = [
    path: TDocumentRef,
    options?: IPdfPathValidationOptions,
];

function fail(message: string): never {
    throw new Error(message);
}

export const pdfValidationPathArgs = s.fromParser<TPdfValidationPathArgs>(
    (value) => {
        if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
            fail('expected 1-2 arguments');
        }
        const args = value as unknown[];
        const path = args[0];
        if (typeof path !== 'string') {
            fail('path must be a string');
        }
        const rawOptions = args[1];
        if (rawOptions === undefined) {
            return [path];
        }
        if (!isRecord(rawOptions) || rawOptions.purpose !== 'opening') {
            fail('validation options must be {purpose: \'opening\'}');
        }
        return [
            path,
            {purpose: 'opening'},
        ];
    },
    () => [
        '/tmp/document.pdf',
        {purpose: 'opening'},
    ],
);
