// Corrections to the gpui-kit.d.ts Herdr App generates, for the editor only: each mod's jsconfig.json includes this,
// and nothing here reaches a mod, since sync.sh copies mod folders and this is outside them.
declare module "herdr" {
  // Declared as strings, but they are hex: a token and a token + "0a" are what the color setters get.
  export function theme(): Record<string, any>;
  // Whatever a mod stored: each key has its own shape.
  export function shared(key: string): any;
  export function settings(): Record<string, any>;
  // Blocks and their fields vary with the layout.
  export function layout(): any;
  // The shipped picker and terminals-bar open with it, and with `at: "top"`, which can't be merged in here: those sites cast.
  export interface OverlaySpec {
    offset?: number;
  }
}

declare module "gpui-kit" {
  // A token plus an alpha is a plain string to TypeScript, and valid hex at run time.
  export interface NativeElement {
    bg<Self extends Element>(this: Self, value: string): Self;
    text_color<Self extends Element>(this: Self, value: string): Self;
    border_color<Self extends Element>(this: Self, value: string): Self;
  }
}

declare module "gpui-shell" {
  // Declared through a Point the checker doesn't pick up; bounds carry x and y at run time.
  export interface ElementBounds {
    x: number;
    y: number;
  }
}
