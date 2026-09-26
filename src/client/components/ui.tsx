import * as DialogPrimitive from "@radix-ui/react-dialog"
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react"
import { useT } from "../lib/i18n"
import { X } from "lucide-react"

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

export function DialogContent({ children, className = "", busy = false }: { children: ReactNode; className?: string; busy?: boolean }) {
  const t = useT()
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dws-dialog-overlay" />
      <DialogPrimitive.Content className={`dws-dialog-content ${className}`} aria-busy={busy || undefined}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}>
        {children}
        <DialogPrimitive.Close className="dws-dialog-close" aria-label={t("close")} disabled={busy}>
          <X size={16} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
