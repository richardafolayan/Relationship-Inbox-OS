import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[620px] items-start px-4 pb-[calc(76px+env(safe-area-inset-bottom))] pt-8 sm:px-10 sm:py-16">
      <section data-consumer-failure="NOT_FOUND" className="rounded-row border border-hairline-strong bg-paper-2 px-5 py-5 text-ink shadow-sm">
        <p className="m-0 text-[16px] font-medium text-ink">This page is no longer here.</p>
        <p className="m-0 mt-1 text-[13px] leading-[1.5] text-ink-3">
          The link may be old, or the item may have moved. Return to Today and open it again from the current list.
        </p>
        <Link
          href="/today"
          className="mt-4 inline-flex min-h-[44px] items-center rounded-pill border border-hairline-strong bg-paper px-4 py-2 text-[12px] font-medium text-ink-2 hover:text-ink"
        >
          Back to Today
        </Link>
      </section>
    </div>
  );
}
