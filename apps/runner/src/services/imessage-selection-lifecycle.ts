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
  let desired = false;
  let revision = 0;

  const apply = async (selected: boolean, expectedRevision: number): Promise<void> => {
    if (selected === active) return;
    if (!selected) {
      deps.stopBirthdaySync();
      deps.stopNameSync();
      deps.stopWatcher();
      active = false;
      return;
    }
    await deps.probe();
    if (revision !== expectedRevision || !desired) return;
    deps.startBirthdaySync();
    deps.startNameSync();
    deps.startWatcher();
    active = true;
  };

  return {
    reconcile(selected: boolean): Promise<void> {
      desired = selected;
      const expectedRevision = ++revision;
      const next = tail.catch(() => undefined).then(() => apply(selected, expectedRevision));
      tail = next;
      return next;
    },
    isActive: () => active
  };
}
