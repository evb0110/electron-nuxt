import {useFatalRuntimeError} from '@app/composables/useFatalRuntimeError';
import {useRuntimeErrorReports} from '@app/composables/useRuntimeErrorReports';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createLogger} from '@electron/utils/createLogger';

// These expected errors make the removal conditions executable. If a receipt-free
// compatibility signature returns, TypeScript reports an unused directive.
// @ts-expect-error A renderer error owner must provide a code or receipt.
BrowserLogger.error('typecheck', 'receipt-free renderer failure', undefined);

// @ts-expect-error A main error owner must provide a code or receipt.
createLogger('typecheck').error('receipt-free main failure');

useRuntimeErrorReports().reportRuntimeError({
    // @ts-expect-error Runtime cards accept only receipt-bearing presentations.
    error: new Error('receipt-free runtime failure'),
    source: 'typecheck',
    title: 'Runtime failure',
});

useFatalRuntimeError().setFatalRuntimeError(
    'runtime',
    new Error('receipt-free fatal failure'),
    // @ts-expect-error Fatal state accepts only receipt-bearing presentations.
    'typecheck',
);
