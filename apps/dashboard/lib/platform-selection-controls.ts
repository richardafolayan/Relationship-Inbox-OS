export function resolvePlatformSelectionControls<T>(input: {
  enabled: boolean;
  primaryLabel: string;
  primaryAction: () => void;
  setupAction: () => void;
  secondaryActions: readonly T[];
}) {
  return input.enabled
    ? {
        statusLabel: null,
        primaryLabel: input.primaryLabel,
        primaryAction: input.primaryAction,
        secondaryActions: [...input.secondaryActions]
      }
    : {
        statusLabel: "Off",
        primaryLabel: "Add in setup",
        primaryAction: input.setupAction,
        secondaryActions: [] as T[]
      };
}
