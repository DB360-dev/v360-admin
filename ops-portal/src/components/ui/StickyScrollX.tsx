import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Horizontal scroller whose scrollbar stays pinned to the bottom of the window
 * (like a spreadsheet), instead of only showing at the end of a long list.
 * The parent must not be overflow-hidden (use overflow-clip) or the bar can't stick.
 */
export function StickyScrollX({ children }: { children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.scrollWidth);
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    measure();
    return () => ro.disconnect();
  }, []);

  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (from && to && to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
  };

  return (
    <>
      <div ref={body} className="no-scrollbar overflow-x-auto" onScroll={() => sync(body.current, bar.current)}>
        {children}
      </div>
      {overflowing && (
        <div ref={bar} aria-hidden onScroll={() => sync(bar.current, body.current)}
          className="sticky-scrollbar sticky bottom-0 z-10 overflow-x-auto border-t border-line bg-surface">
          <div style={{ width, height: 1 }} />
        </div>
      )}
    </>
  );
}
