interface IMessageSelectionLifecycleDeps {
  probe(): Promise<void>;
  startBirthdaySync(): void;
  stopBirthdaySync(): void;
  startNameSync(): void;
  stopNameSync(): void;
  startWatcher(): void;
  stopWatcher(): void;
}

export function createIMessageSelectionLifecycle(
  deps: IMessageSelectionLifecycleDeps
) {
  let active = false;
  let tail: Promise<void> = Promise.resolve();

  const apply = async (selected: boolean): Promise<void> => {
    if (selected === active) return;
    if (!selected) {
      deps.stopBirthdaySync();
      deps.stopNameSync();
      deps.stopWatcher();
      active = false;
      return;
    }
    await deps.probe();
    deps.startBirthdaySync();
    deps.startNameSync();
    deps.startWatcher();
    active = true;
  };

  return {
    reconcile(selected: boolean): Promise<void> {
      const next = tail.catch(() => undefined).then(() => apply(selected));
      tail = next;
      return next;
    },
    isActive: () => active
  };
}
