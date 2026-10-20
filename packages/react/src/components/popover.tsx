import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface Anchor {
  /** Position relative to the grid's root element. */
  x: number;
  y: number;
  /** Height of the anchor, so that the popover can open above it when there is no room below. */
  height?: number;
}

/**
 * A panel positioned inside the grid's root. Closes on Escape and on pointer presses outside, and
 * returns focus to `returnFocus` when it closes.
 */
export function Popover({
  anchor,
  container,
  onClose,
  returnFocus,
  label,
  role = "dialog",
  className,
  children,
  initialFocus = true,
}: {
  anchor: Anchor;
  container: RefObject<HTMLElement | null>;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
  label: string;
  role?: "dialog" | "menu";
  className?: string;
  children: ReactNode;
  initialFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const element = ref.current;
    const root = container.current;
    if (!element || !root) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const maxLeft = Math.max(4, root.clientWidth - width - 4);
    const below = anchor.y + (anchor.height ?? 0) + 2;
    const above = anchor.y - height - 2;
    const top = below + height <= root.clientHeight - 4 || above < 4 ? below : above;
    setPosition({ left: Math.min(Math.max(4, anchor.x), maxLeft), top: Math.max(4, top) });
  }, [anchor, container]);

  useEffect(() => {
    if (initialFocus) {
      const target = ref.current?.querySelector<HTMLElement>(
        "[data-autofocus], input, button, [tabindex='0'], [role='menuitem']",
      );
      target?.focus({ preventScroll: true });
    }
    const returnTo = returnFocus?.current;
    const element = ref.current;
    function onPointerDown(event: PointerEvent) {
      if (element && !element.contains(event.target as Node)) close.current();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      // Return focus when it was inside the panel (it falls back to the body when the panel is removed),
      // but not when the user moved it elsewhere, for example by clicking outside.
      const active = document.activeElement;
      if (returnTo && (!active || active === document.body || element?.contains(active))) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, [initialFocus, returnFocus]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      returnFocus?.current?.focus({ preventScroll: true });
      onClose();
    }
  }

  const props = {
    ref,
    className: `vg-popover${className ? ` ${className}` : ""}`,
    "aria-label": label,
    // The first render uses the anchor; the layout effect corrects the position before the browser paints.
    // (A hidden first render would make the panel unfocusable when the focus effect runs.)
    style: position ? { left: position.left, top: position.top } : { left: anchor.x, top: anchor.y },
    onKeyDown,
  };
  return role === "menu" ? (
    <div role="menu" {...props}>
      {children}
    </div>
  ) : (
    <div role="dialog" {...props}>
      {children}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Draws a separator above the item. */
  separator?: boolean;
  checked?: boolean;
  shortcut?: string;
}

/** A menu list with arrow-key navigation. Selecting an item closes the menu. */
export function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  function move(event: KeyboardEvent, step: number) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      step === Number.POSITIVE_INFINITY
        ? buttons.length - 1
        : step === Number.NEGATIVE_INFINITY
          ? 0
          : (index + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") move(event, 1);
    else if (event.key === "ArrowUp") move(event, -1);
    else if (event.key === "Home") move(event, Number.NEGATIVE_INFINITY);
    else if (event.key === "End") move(event, Number.POSITIVE_INFINITY);
    else if (event.key === "Tab") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the menu items inside are the interactive elements; this handles their arrow keys.
    <div ref={ref} className="vg-menu" onKeyDown={onKeyDown}>
      {items.map((item) => (
        <div key={item.label}>
          {item.separator && <hr className="vg-menu__separator" />}
          {item.checked === undefined ? (
            <button
              type="button"
              role="menuitem"
              className="vg-menu__item"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ) : (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              className="vg-menu__item"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
