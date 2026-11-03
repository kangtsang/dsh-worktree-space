/**
 * Where a floating panel is rendered.
 *
 * The create dialog is modal, and a modal dialog's focus scope takes focus back from
 * anything outside its own content: a panel portalled to `document.body` can hold a list
 * of branches, but its search box never keeps the caret - a click hands focus straight
 * back to the dialog, so the field looks unfocusable. Rendering the panel inside the
 * dialog's content keeps it inside that scope, which is what lets the list be typed into.
 *
 * The panel still places itself in viewport coordinates (`position: fixed`): the dialog's
 * content carries no transform, so its fixed descendants stay measured against the
 * viewport and are painted over the body's clipping edge rather than cut off by it. That
 * is also why the dialog must not gain a transform - see the rule for `.dws-dialog-content`.
 * @param anchor - the control the panel belongs to.
 * @returns the dialog content that owns the control, or the document body when there is none.
 */
export function panelHost(anchor: HTMLElement | null): HTMLElement {
  return anchor?.closest<HTMLElement>(".dws-dialog-content") ?? document.body
}
