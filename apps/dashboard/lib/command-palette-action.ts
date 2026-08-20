export type CommandPaletteAction =
  | { href: string; run?: never }
  | { href?: never; run: () => void };

export function activateCommandPaletteAction(
  action: CommandPaletteAction,
  callbacks: { navigate: (href: string) => void; close: () => void }
): void {
  if (action.href !== undefined) {
    callbacks.navigate(action.href);
  } else {
    action.run();
  }
  callbacks.close();
}
