import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const fieldVariants = cva("group/field flex w-full gap-3", {
  variants: {
    orientation: {
      horizontal: "flex-row items-center justify-between",
      responsive: "flex-col sm:flex-row sm:items-center sm:justify-between",
      vertical: "flex-col",
    },
  },
  defaultVariants: {
    orientation: "vertical",
  },
});

function Field({ className, orientation = "vertical", ...props }) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

function FieldContent({ className, ...props }) {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 leading-snug",
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }) {
  return (
    <label
      data-slot="field-label"
      className={cn(
        "flex w-fit gap-2 text-body-md font-medium leading-snug text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Field, FieldContent, FieldLabel };
