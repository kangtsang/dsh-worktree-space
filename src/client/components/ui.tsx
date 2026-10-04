import * as DialogPrimitive from "@radix-ui/react-dialog"
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { useT } from "../lib/i18n"
import { X } from "./icons"

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`dws-button ${className}`} {...props} />
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`dws-input ${className}`} {...props} />
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`dws-select ${className}`} {...props} />
}

export function Dialog({ children, ...props }: DialogPrimitive.DialogProps) {
  return <DialogPrimitive.Root {...props}>{children}</DialogPrimitive.Root>
}

/**
 * The body of a dialog.
 *
 * `showClose` drops the corner close button. A confirmation asks one question and
 * answers it with 取消 / 确认, so the corner button is the same way out wearing a
 * different shape - and where the body starts at the top of the dialog rather than
 * under a heading, it sat on top of the first line of the sentence.
 *
 * The button is not rendered at all rather than hidden with CSS: a `display: none`
 * button is still in the tab order, which puts keyboard focus somewhere the eye
 * cannot follow.
 * @param props.children - the dialog's own content.
 * @param props.className - extra classes for the dialog surface.
 * @param props.busy - whether the work the dialog started is still running, which
 *   blocks closing it by the keyboard or by clicking outside.
 * @param props.showClose - whether to draw the corner close button.
 * @returns the dialog, drawn in a portal over the page.
 */
export function DialogContent({ children, className = "", busy = false, showClose = true }: {
  children: ReactNode
  className?: string
  busy?: boolean
  showClose?: boolean
}) {
  const t = useT()
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dws-dialog-overlay" />
      <DialogPrimitive.Content className={`dws-dialog-content ${className}`} aria-busy={busy || undefined}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}>
        {children}
        {showClose
          ? <DialogPrimitive.Close className="dws-dialog-close" aria-label={t("close")} disabled={busy}>
            <X size={16} />
          </DialogPrimitive.Close>
          : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
