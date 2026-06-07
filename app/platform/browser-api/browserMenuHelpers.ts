import type { IMenuEventUnsubscribe } from '@contracts/electronApiCommon';

function noopUnsubscribe(): IMenuEventUnsubscribe {
    return () => {};
}

export { noopUnsubscribe };
