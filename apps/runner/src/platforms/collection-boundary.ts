import type { PlatformCollectionBoundaryCapability } from "@inbox-os/core";

export const AUTHORITATIVE_COLLECTION_BOUNDARY: PlatformCollectionBoundaryCapability = {
  beginCycle: () => undefined,
  getMetrics: () => ({
    totalFound: 0,
    unreadFound: 0,
    completeness: "complete",
    nativeStopReason: "authoritative_by_construction"
  })
};

export const BOUNDED_COLLECTION_BOUNDARY: PlatformCollectionBoundaryCapability = {
  beginCycle: () => undefined,
  getMetrics: () => ({
    totalFound: 0,
    unreadFound: 0,
    completeness: "incomplete",
    nativeStopReason: "bounded_by_construction"
  })
};
