import { HugeiconsIcon } from "@hugeicons/react"
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon"
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon"
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon"
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon"
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon"
import CheckIcon from "@hugeicons/core-free-icons/CheckIcon"
import FolderClosedIcon from "@hugeicons/core-free-icons/FolderClosedIcon"
import FolderGit2Icon from "@hugeicons/core-free-icons/FolderGit2Icon"
import FolderGitIcon from "@hugeicons/core-free-icons/FolderGitIcon"
import GitPullRequestIcon from "@hugeicons/core-free-icons/GitPullRequestIcon"
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon"
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon"
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon"
import RefreshCwIcon from "@hugeicons/core-free-icons/RefreshCwIcon"
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon"
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon"
import type { ComponentProps } from "react"

/**
 * The plugin's icon surface: Hugeicons, behind the three props the call sites pass.
 *
 * `HugeiconsIcon` takes its glyph as an `icon` prop rather than as the component itself,
 * so every call site would otherwise carry `icon={SomeIcon}` and a default stroke width.
 * This wraps that once: each constant below is named for the glyph it draws, and the
 * weight is the family's own 1.5 rather than each call site's guess.
 *
 * Hugeicons' stroke-rounded set is the family DSH's own chrome is drawn from, so the
 * plugin's glyphs share a weight and a corner radius with the shell's instead of merely
 * sitting beside them. Each glyph is imported from its own file: the package ships 6,000
 * of them, and only the fifteen below are in the bundle.
 */
type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon"> & { className?: string }

/**
 * One glyph's data: the tag-and-attributes pairs an icon module exports. The package does
 * not export this type by name — its index declares it privately, and the icon modules
 * import it from an internal path — so the shape is taken from the component that consumes
 * it rather than reached for through `dist/`.
 */
type IconGlyph = ComponentProps<typeof HugeiconsIcon>["icon"]

/**
 * One glyph as a component shaped like the ones this plugin used before: `<Icon size={16}
 * className=… aria-hidden />`, with the stroke already set.
 * @param icon - the glyph, imported one file at a time so only the ones used ship.
 * @returns a component that draws it.
 */
function iconOf(icon: IconGlyph) {
  const Icon = ({ strokeWidth = 1.5, ...props }: IconProps) => <HugeiconsIcon icon={icon} strokeWidth={strokeWidth} {...props} />
  return Icon
}

/* One folder per kind of row, and they are not the same drawing: a repository and every
   worktree inside it wear the Git folder, a task space and a Workspace the plain closed
   one, and nothing else leads a row. */
/** One folder holding a Git working tree: a repository, and every worktree it holds. */
export const FolderGit2 = iconOf(FolderGit2Icon)
/**
 * The same folder with a Git node on it: a repository, drawn at the size of a header.
 *
 * It is `FolderGit2`'s claim in a simpler drawing, for the one place a repository leads a
 * row rather than sitting inside one, and for the empty list of them.
 */
export const FolderGit = iconOf(FolderGitIcon)
/**
 * A plain closed folder: a task space, and a Workspace, the two kinds of row that are
 * nothing but a folder an agent or a repository was pointed at.
 */
export const FolderClosed = iconOf(FolderClosedIcon)
/**
 * A branch or a pull request, beside a branch name.
 *
 * The glyph is only ever a label here: the rows it sits on are already led by a folder
 * that says what kind of thing they are, so this one claims a relation to a branch
 * rather than the row itself.
 */
export const GitPullRequest = iconOf(GitPullRequestIcon)
/** The hint glyph: it says nothing on its own, and the hover bubble is where it speaks. */
export const InformationCircle = iconOf(InformationCircleIcon)
export const AlertCircle = iconOf(AlertCircleIcon)
export const Check = iconOf(CheckIcon)
/** The spinner: a loader, turned by the `dws-spin` animation its call sites add. */
export const Loader2 = iconOf(Loading03Icon)
export const X = iconOf(Cancel01Icon)
export const ChevronLeft = iconOf(ArrowLeft01Icon)
export const ChevronRight = iconOf(ArrowRight01Icon)
export const ChevronDown = iconOf(ArrowDown01Icon)
export const Plus = iconOf(PlusSignIcon)
export const RefreshCw = iconOf(RefreshCwIcon)
export const Search = iconOf(Search01Icon)
/** The gear: the one glyph that means "this leads to the plugin's settings page". */
export const Settings = iconOf(Settings02Icon)

/**
 * The plugin's own mark: the one glyph not drawn by Hugeicons.
 *
 * The plugin was known by this drawing before it moved to Hugeicons, and it is the mark
 * that stands for the plugin itself - in the sidebar's panel list, in its footer, and
 * beside the workspace selector - rather than for a kind of row. Keeping it is the point:
 * a reader recognises the plugin by it, and the row glyphs beside it are a different
 * question. Reproduced from `lucide-react` 0.474.0 `folder-git-2` (ISC), the version this
 * plugin shipped before the icon family changed, paths and all, so the mark is the same
 * drawing rather than a near neighbour of it.
 */
export function BrandGlyph({ size = 24, className, "aria-hidden": ariaHidden }: {
  size?: number
  className?: string
  "aria-hidden"?: boolean | "true" | "false"
}) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    className={className} aria-hidden={ariaHidden}>
    <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
    <circle cx="13" cy="12" r="2" />
    <path d="M18 19c-2.8 0-5-2.2-5-5v8" />
    <circle cx="20" cy="19" r="2" />
  </svg>
}
