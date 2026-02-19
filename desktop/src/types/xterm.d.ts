declare module '@xterm/xterm' {
  export interface IDisposable {
    dispose(): void;
  }

  export class Terminal {
    constructor(options?: Record<string, unknown>);
    cols: number;
    rows: number;
    loadAddon(addon: unknown): void;
    open(parent: HTMLElement): void;
    onData(listener: (data: string) => void): IDisposable;
    write(data: string): void;
    reset(): void;
    focus(): void;
    dispose(): void;
  }
}

declare module '@xterm/addon-fit' {
  export class FitAddon {
    activate(terminal: unknown): void;
    dispose(): void;
    fit(): void;
  }
}

declare module '@xterm/xterm/css/xterm.css';
