import { type ReactNode, Suspense, type ToggleEvent, use, useEffect, useId, useRef, useState } from "react";
import { LocaleContext } from "./context.js";

/**
 * A button of the toolbar and its popover, whose content is rendered only while it is open, so that a content loaded
 * with `lazy` is downloaded when it is first opened (§10 of v2-react.md) and starts from the state as it is then. The
 * popover opens under the button, its right edge at the button's, and follows its content's size.
 */
export function ToolbarPopover({
  label,
  title,
  className,
  pressed,
  children,
}: {
  label: ReactNode;
  title: string;
  className: string;
  pressed?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const { messages } = use(LocaleContext);
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const place = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
    };
    place();
    // The content may arrive after the popover opened.
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [open]);

  const onToggle = (event: ToggleEvent<HTMLDivElement>) => setOpen(event.newState === "open");
  // By id, not by the ref: the content gets it during render.
  const close = () => document.getElementById(id)?.hidePopover();

  return (
    <>
      <button ref={buttonRef} type="button" className="vg-button" popoverTarget={id} aria-pressed={pressed}>
        {label}
      </button>
      <div
        ref={menuRef}
        id={id}
        popover="auto"
        role="dialog"
        className={`vg-menu ${className}`}
        aria-label={title}
        onToggle={onToggle}
      >
        {open && (
          <Suspense fallback={<p className="vg-filter__note">{messages.loading}</p>}>{children(close)}</Suspense>
        )}
      </div>
    </>
  );
}
