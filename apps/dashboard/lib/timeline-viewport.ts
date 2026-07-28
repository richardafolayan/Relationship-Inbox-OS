export type TimelineViewportSnapshot = {
  scrollTop: number;
  distanceFromBottom: number;
};

export function snapshotTimelineViewport(
  timeline: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">
): TimelineViewportSnapshot {
  return {
    scrollTop: timeline.scrollTop,
    distanceFromBottom: Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop
    )
  };
}

export function timelineScrollTopAfterResize(
  snapshot: TimelineViewportSnapshot,
  next: Pick<HTMLElement, "scrollHeight" | "clientHeight">,
  bottomThreshold: number
): number {
  if (snapshot.distanceFromBottom <= bottomThreshold) {
    return Math.max(
      0,
      next.scrollHeight - next.clientHeight - snapshot.distanceFromBottom
    );
  }
  return snapshot.scrollTop;
}

export function timelineSnapshotForResize(
  snapshot: TimelineViewportSnapshot,
  stickToBottom: boolean,
  bottomThreshold: number
): TimelineViewportSnapshot {
  if (stickToBottom && snapshot.distanceFromBottom > bottomThreshold) {
    return { ...snapshot, distanceFromBottom: 0 };
  }
  return snapshot;
}
