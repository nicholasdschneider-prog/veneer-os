import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Popover, Slot } from "radix-ui"
import { ChevronDown, Paperclip } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const attachmentVariants = cva(
  "group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 flex-wrap rounded-xl border bg-card text-card-foreground transition-colors focus-within:ring-1 focus-within:ring-ring/50 has-[>a,>button]:hover:bg-muted/50 data-[state=error]:border-destructive/30 data-[state=idle]:border-dashed",
  {
    variants: {
      size: {
        default:
          "gap-2 text-sm has-data-[slot=attachment-content]:px-2.5 has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-media]:p-2",
        sm: "gap-2.5 text-xs has-data-[slot=attachment-content]:px-2 has-data-[slot=attachment-content]:py-1.5 has-data-[slot=attachment-media]:p-1.5",
        xs: "gap-1.5 rounded-lg text-xs has-data-[slot=attachment-content]:px-1.5 has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-media]:p-1",
      },
      orientation: {
        horizontal: "min-w-40 items-center",
        vertical: "w-24 flex-col has-data-[slot=attachment-content]:w-30",
      },
    },
  }
)

function Attachment({
  className,
  state = "done",
  size = "default",
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof attachmentVariants> & {
    state?: "idle" | "uploading" | "processing" | "error" | "done"
  }) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      className={cn(attachmentVariants({ size, orientation }), className)}
      {...props}
    />
  )
}

const attachmentMediaVariants = cva(
  "relative flex aspect-square w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-foreground group-data-[orientation=vertical]/attachment:w-full group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[size=xs]/attachment:rounded-md group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive group-data-[orientation=vertical]/attachment:*:data-[slot=spinner]:size-6! [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 group-data-[orientation=vertical]/attachment:[&_svg:not([class*='size-'])]:size-6 group-data-[size=xs]/attachment:[&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        icon: "",
        image:
          "opacity-60 group-data-[state=done]/attachment:opacity-100 group-data-[state=idle]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "icon",
    },
  }
)

function AttachmentMedia({
  className,
  variant = "icon",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof attachmentMediaVariants>) {
  return (
    <div
      data-slot="attachment-media"
      data-variant={variant}
      className={cn(attachmentMediaVariants({ variant }), className)}
      {...props}
    />
  )
}

function AttachmentContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-content"
      className={cn(
        "max-w-full min-w-0 flex-1 leading-tight group-data-[orientation=vertical]/attachment:px-1",
        className
      )}
      {...props}
    />
  )
}

function AttachmentTitle({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-title"
      className={cn(
        "block max-w-full min-w-0 truncate font-medium group-data-[state=processing]/attachment:shimmer group-data-[state=uploading]/attachment:shimmer",
        className
      )}
      {...props}
    />
  )
}

function AttachmentDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-description"
      className={cn(
        "mt-0.5 block min-w-0 truncate text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive/80",
        "max-w-full",
        className
      )}
      {...props}
    />
  )
}

function AttachmentActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-actions"
      className={cn(
        "relative z-20 flex shrink-0 items-center group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:top-3 group-data-[orientation=vertical]/attachment:right-3 group-data-[orientation=vertical]/attachment:gap-1",
        className
      )}
      {...props}
    />
  )
}

function AttachmentAction({
  className,
  variant,
  size = "icon-xs",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="attachment-action"
      variant={variant ?? "ghost"}
      size={size}
      className={cn(className)}
      {...props}
    />
  )
}

function AttachmentTrigger({
  className,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="attachment-trigger"
      type={asChild ? undefined : (type ?? "button")}
      className={cn("absolute inset-0 z-10 outline-none", className)}
      {...props}
    />
  )
}

function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-group"
      className={cn(
        "flex min-w-0 scroll-fade-x snap-x snap-mandatory scroll-px-1 scrollbar-none gap-3 overflow-x-auto overscroll-x-contain py-1 *:data-[slot=attachment]:flex-none *:data-[slot=attachment]:snap-start",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a set of attachments as inline chips while they comfortably fit a
 * single row, and collapses them into a dropdown (a "N files ▾" pill that opens
 * a scrollable list) once there are too many. "Too many" means either the count
 * exceeds `threshold`, or the chips would overflow past one row — measured live
 * so the same list stays inline on a wide desktop composer but collapses on a
 * narrow phone.
 *
 * `renderChip` draws one inline chip (an <Attachment>); `renderRow` draws one
 * item in the dropdown list. Callers own both so the read-only "files from this
 * chat" list and the interactive pending-uploads list can differ.
 */
function CollapsibleAttachments<T>({
  items,
  getKey,
  threshold = 3,
  label,
  renderChip,
  renderRow,
  className,
}: {
  items: T[]
  getKey: (item: T) => string
  threshold?: number
  label: (count: number) => string
  renderChip: (item: T) => React.ReactNode
  renderRow: (item: T) => React.ReactNode
  className?: string
}) {
  // Past the hard count cap we never show chips, so skip mounting (and, for
  // image attachments, loading) the inline row entirely.
  const overCap = items.length > threshold
  const rowRef = React.useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = React.useState(overCap)

  React.useLayoutEffect(() => {
    if (overCap) {
      setCollapsed(true)
      return
    }
    const el = rowRef.current
    if (!el) return
    // +1 to absorb sub-pixel rounding; scrollWidth > clientWidth ⇒ the chips
    // don't fit one row, so collapse to the dropdown.
    const measure = () => setCollapsed(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [items.length, threshold, overCap])

  if (items.length === 0) return null

  return (
    <div className={cn("relative", className)}>
      {overCap ? null : (
        // Kept mounted even when collapsed (positioned out of flow, hidden) so
        // its natural width can still be measured when the composer resizes.
        <div
          ref={rowRef}
          aria-hidden={collapsed || undefined}
          className={cn(
            "flex min-w-0 flex-nowrap gap-2 overflow-hidden py-1 *:data-[slot=attachment]:flex-none",
            collapsed && "pointer-events-none invisible absolute inset-x-0 top-0"
          )}
        >
          {items.map((item) => (
            <React.Fragment key={getKey(item)}>{renderChip(item)}</React.Fragment>
          ))}
        </div>
      )}
      {collapsed ? (
        <div className="py-1">
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="group/files inline-flex max-w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-xs font-medium text-card-foreground outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring/50"
              >
                <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{label(items.length)}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/files:rotate-180" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={12}
                className="z-50 flex max-h-[min(60vh,22rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-md"
              >
                {items.map((item) => (
                  <React.Fragment key={getKey(item)}>{renderRow(item)}</React.Fragment>
                ))}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      ) : null}
    </div>
  )
}

export {
  Attachment,
  AttachmentGroup,
  CollapsibleAttachments,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
}
