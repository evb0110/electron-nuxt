import type { IMenuEventUnsubscribe } from '@contracts/platformApi';

function noopUnsubscribe(): IMenuEventUnsubscribe {
    return () => {};
}

export { noopUnsubscribe };
