import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  icon: ReactNode;
  label: string;
}

/**
 * Compact selection action: icon-only at rest, with a label that expands on
 * pointer hover or focus. The accessible name remains available at all times.
 */
export function ExpandableSelectionAction({
  icon,
  label,
  className,
  title,
  type = "button",
  ...props
}: Props) {
  return (
    <button
      type={type}
      aria-label={props["aria-label"] ?? label}
      title={title ?? label}
      className={cn(
        "group inline-flex h-9 min-w-9 shrink-0 items-center justify-center overflow-hidden rounded-md px-2 text-[12px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40",
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      <span
        aria-hidden="true"
        className="max-w-0 -translate-x-1 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,margin,opacity,transform] duration-200 ease-out group-hover:ml-1 group-hover:max-w-20 group-hover:translate-x-0 group-hover:opacity-100 group-focus:ml-1 group-focus:max-w-20 group-focus:translate-x-0 group-focus:opacity-100 motion-reduce:transition-none"
      >
        {label}
      </span>
    </button>
  );
}
