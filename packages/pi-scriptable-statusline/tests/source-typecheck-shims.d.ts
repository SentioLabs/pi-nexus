declare module "@mariozechner/pi-coding-agent" {
  export type ExtensionAPI = any;
}

declare module "@mariozechner/pi-tui" {
  export function visibleWidth(text: string): number;
  export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

declare module "node:fs" {
  export const existsSync: any;
  export const copyFileSync: any;
  export const mkdirSync: any;
  export const watch: any;
}

declare module "node:os" {
  export const homedir: any;
}

declare module "node:path" {
  export const basename: any;
  export const dirname: any;
}

declare module "node:url" {
  export const pathToFileURL: any;
}

declare const process: {
  cwd: () => string;
};
