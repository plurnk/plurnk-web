interface Window {
    [key: string]: any;
}

interface Node {
    matches?(selectors: string): boolean;
    getAttribute?(qualifiedName: string): string | null;
}

interface Element {
    alt: string;
    complete: boolean;
    readonly dataset: DOMStringMap;
    disabled: boolean;
    form: HTMLFormElement | null;
    innerText: string;
    naturalHeight: number;
    naturalWidth: number;
    open: boolean;
    src: string;
    style: CSSStyleDeclaration;
    title: string;
    readonly validity: ValidityState;
    click(): void;
    checkValidity(): boolean;
    requestSubmit(submitter?: HTMLElement | null): void;
}

interface PromiseFulfilledResult<T> {
    reason?: any;
}

interface PromiseRejectedResult {
    value?: any;
}

declare module "node:fs/promises" {
    function mkdtemp(prefix: string | URL): Promise<string>;
}

declare module "node:net" {
    interface Server {
        address(): AddressInfo;
    }
}

interface PromiseConstructor {
    new (executor: (resolve: (value?: any) => void, reject: (reason?: any) => void) => void): Promise<any>;
    withResolvers(): {
        promise: Promise<any>;
        resolve: (value?: any) => void;
        reject: (reason?: any) => void;
    };
}




