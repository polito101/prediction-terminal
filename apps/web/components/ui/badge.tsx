import * as React from "react";

import { cn } from "@/lib/utils";

type BadgeVariant = "green" | "red" | "gray";

function variantClass(variant: BadgeVariant): string {
  if (variant === "green") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (variant === "red") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-zinc-700/40 text-zinc-200 border-zinc-600";
}

export function Badge({
  className,
  variant = "gray",
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
        variantClass(variant),
        className,
      )}
      {...props}
    />
  );
}
