"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import {
  beginSearchInboxLoad,
  completeSearchInboxLoad,
  createSearchInboxState,
  failSearchInboxLoad,
  type SearchInboxState
} from "@/lib/search-inbox-state";

export type SearchInboxData = SearchInboxState & {
  refresh: () => Promise<void>;
};

export function useSearchInbox(): SearchInboxData {
  const [state, setState] = useState<SearchInboxState>(createSearchInboxState);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setState((current) => beginSearchInboxLoad(current));

    try {
      const data = await apiGet<InboxResponse>("/runner/data/inbox");
      if (requestVersion !== requestVersionRef.current) return;
      setState(completeSearchInboxLoad(data.rows));
    } catch {
      if (requestVersion !== requestVersionRef.current) return;
      setState((current) => failSearchInboxLoad(current));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => {
      requestVersionRef.current += 1;
      window.removeEventListener("runner-resync", onResync);
    };
  }, [refresh]);

  return {
    ...state,
    refresh
  };
}
