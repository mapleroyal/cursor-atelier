import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Collapsible(props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  );
}

function CollapsibleContent({
  animated = false,
  children,
  className,
  ...props
}) {
  if (!animated) {
    return (
      <CollapsiblePrimitive.Content
        data-slot="collapsible-content"
        className={className}
        {...props}
      >
        {children}
      </CollapsiblePrimitive.Content>
    );
  }

  return (
    <CollapsiblePrimitive.Content
      data-slot="collapsible-content"
      className="overflow-hidden motion-reduce:animate-none data-[state=closed]:animate-[collapsible-up_150ms_ease-out] data-[state=open]:animate-[collapsible-down_150ms_ease-out]"
      {...props}
    >
      <div className={cn(className)}>{children}</div>
    </CollapsiblePrimitive.Content>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
