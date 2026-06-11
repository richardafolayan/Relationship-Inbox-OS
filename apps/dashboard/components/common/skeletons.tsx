import { Canvas } from "@/components/common/canvas";
import { BrandLoader } from "@/components/common/brand-loader";

// Dependency-free loading skeletons rendered by Next's route-level
// loading.tsx files. They paint the page chrome the instant a navigation
// starts — before the page's client JS chunk and its runner data have
// arrived — so "click a page and stare at blank" becomes "click a page and
// see the layout, then content fills in". Pure server components: no hooks,
// no client bundle, no data. The BrandLoader mark fades in only if the wait
// outlasts its reveal delay, so instant paints never flash it.

function Bar({ className = "" }: { className?: string }) {
  return <span className={`block animate-pulse rounded bg-paper-3 ${className}`} aria-hidden />;
}

/** Header + N shimmer rows — for the Today / Inbox / Archived list pages. */
export function ListPageSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <Canvas className="max-w-[1240px] pb-10">
      <div className="-mx-12 mb-6 flex items-end justify-between px-12 pb-3 pt-6">
        <div>
          <Bar className="h-7 w-44" />
          <Bar className="mt-3 h-3 w-72" />
        </div>
        <BrandLoader />
      </div>
      <div className="flex flex-col" aria-hidden>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] last:border-b last:border-hairline"
          >
            <span className="h-8 w-8 animate-pulse rounded-full bg-paper-3" />
            <span className="min-w-0">
              <Bar className="mb-2 h-[15px] w-40" />
              <Bar className="h-[14px] w-full max-w-[52ch]" />
            </span>
            <Bar className="h-[12px] w-14" />
          </div>
        ))}
      </div>
    </Canvas>
  );
}

/** Chat column + rail skeleton — for the thread workspace. */
export function ThreadSkeleton() {
  return (
    <div className="flex h-full w-full gap-6 px-6 py-6" aria-hidden>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="h-9 w-9 animate-pulse rounded-full bg-paper-3" />
            <div>
              <Bar className="h-[16px] w-44" />
              <Bar className="mt-2 h-[12px] w-28" />
            </div>
          </div>
          <BrandLoader />
        </div>
        {/* Bubbles */}
        <div className="flex flex-1 flex-col justify-end gap-4">
          <Bar className="h-12 w-[58%] rounded-2xl" />
          <Bar className="h-9 w-[42%] self-end rounded-2xl" />
          <Bar className="h-16 w-[64%] rounded-2xl" />
          <Bar className="h-10 w-[48%] self-end rounded-2xl" />
          <Bar className="h-12 w-[52%] rounded-2xl" />
        </div>
        {/* Composer */}
        <Bar className="mt-6 h-14 w-full rounded-xl" />
      </div>
      {/* Context rail */}
      <div className="hidden w-[340px] shrink-0 flex-col gap-4 lg:flex">
        <Bar className="h-24 w-full rounded-xl" />
        <Bar className="h-32 w-full rounded-xl" />
        <Bar className="h-20 w-full rounded-xl" />
      </div>
    </div>
  );
}
