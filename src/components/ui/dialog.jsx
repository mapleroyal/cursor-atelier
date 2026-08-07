import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Dialog(props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogClose(props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogPortal(props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs motion-reduce:animate-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({ className, ...props }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-5 rounded-3xl bg-background p-6 shadow-2xl ring-1 ring-foreground/10 duration-100 outline-none motion-reduce:animate-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("grid gap-1.5", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex justify-end gap-2", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
};
