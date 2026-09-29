// The Web platform globals the trial driver uses (Node has them; the CLI builds with lib ES2022
// and no @types/node). These merge with the AbortSignal declared in @jevris/contracts.
interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

declare var AbortController: {
  new (): AbortController;
};
