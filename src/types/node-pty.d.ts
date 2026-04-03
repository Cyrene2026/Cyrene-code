declare module "node-pty" {
  export type IPtyForkOptions = {
    cwd?: string;
    env?: Record<string, string>;
    name?: string;
    cols?: number;
    rows?: number;
  };

  export type IEvent<T> = {
    dispose: () => void;
  };

  export type IExitEvent = {
    exitCode: number;
    signal?: number | string;
  };

  export type IPty = {
    write(data: string): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): IEvent<string>;
    onExit(listener: (event: IExitEvent) => void): IEvent<IExitEvent>;
  };

  export function spawn(
    file: string,
    args?: string[],
    options?: IPtyForkOptions
  ): IPty;
}
