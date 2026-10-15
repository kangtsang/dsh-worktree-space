import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw, X } from "./icons"
import { format, useT } from "../lib/i18n"
import { gateMissingText } from "../lib/deploy-gate-text"
import { hostWarningText, type HostWarning } from "../lib/host-messages"
import { acceptanceUrl } from "../lib/links"
import { Button } from "./ui"
import type { DeliveryGatePreview, DeploymentStatus } from "../lib/types"

interface Props {
  api: any
  /** The task space directory the deployment belongs to. */
  path: string
}

/** The local clock, in the audit log's own format: `YYYY-MM-DD HH:mm:ss`, 19 characters. */
function stamp(iso: string | null | undefined) {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * The deployment card a task row carries: the acceptance URL on its own line, the
 * smoke the deploy last ran, and the actions under them.
 *
 * It reads the deployment live on mount and on demand — a dynamic port changes with
 * every deploy, so nothing here is remembered. It renders nothing at all for a task
 * whose policy deploys nothing and whose disk and docker hold no deployment: a card
 * that says "nothing is deployed" on every row would be noise the panel pays for on
 * every task that never asked for one.
 *
 * Destroying is a two-press button rather than a `window.confirm`: the console may
 * be hosted where native dialogs are suppressed, and a suppressed confirm answers
 * "no" silently — a destroy that looks clicked and never happened.
 */
export function DeployCard({ api, path }: Props) {
  const t = useT()
  const [status, setStatus] = useState<DeploymentStatus | null>(null)
  // What the last deploy or smoke said a finish would still be waiting for. Held
  // beside the status rather than folded into it: it is an answer about the
  // *policy*, produced by an action, and a plain status read cannot produce it.
  const [gate, setGate] = useState<DeliveryGatePreview | null>(null)
  const [error, setError] = useState("")
  // A warning is not an error: the action ran and answered, and this is what it could
  // not finish. Kept apart from `error` for that reason - the red line says the call
  // failed, and a destroy that removed three of five containers failed at neither.
  const [warning, setWarning] = useState("")
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  // Whether the last smoke this card ran was stopped at its deadline rather than
  // finishing. Held beside the status rather than folded into it, because the status
  // comes from the state file the script writes - and a script that was stopped never
  // got to write one, so the badge would otherwise go on showing whatever the last
  // completed run recorded, as though this one had answered.
  const [smokeTimedOut, setSmokeTimedOut] = useState(false)
  const [armingDestroy, setArmingDestroy] = useState(false)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next: DeploymentStatus = await api.deployStatus(path, { signal })
      // A read that was aborted describes a state nobody is waiting for any more -
      // the card is gone, or a later press has replaced it. Painting it would put a
      // stale answer on screen, and on unmount it would be a state update into
      // nothing, which is the same bug the mount effect's abort exists to prevent.
      if (signal?.aborted) return
      setStatus(next)
      setFailed(false)
      setError("")
    } catch {
      if (signal?.aborted) return
      // A read that came back empty is not a card: a machine without docker, a
      // task space that is gone — the row above already says what that is.
      setFailed(true)
    }
  }, [api, path])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  // The controller for the read `run` falls back to when an action answers with
  // nothing to paint. Held in a ref so unmounting aborts it, exactly as the effect
  // above does for the read on mount: without a signal the fallback could set state
  // into a card that is already gone.
  const runController = useRef<AbortController | null>(null)
  useEffect(() => () => runController.current?.abort(), [])

  // An armed destroy disarms itself, so a first press left alone means nothing.
  useEffect(() => () => { if (disarmTimer.current !== null) clearTimeout(disarmTimer.current) }, [])

  async function run(action: () => Promise<{ status?: DeploymentStatus } | unknown>) {
    setWorking(true)
    try {
      // Operations that ran a script answer with the live status already in hand
      // (the smoke's own verdict is in it, red included) - paint that, and only
      // fall back to a fresh read when the action returned nothing to paint.
      const result = await action() as { status?: DeploymentStatus; gate?: DeliveryGatePreview; timedOut?: boolean; warning?: HostWarning | string } | undefined
      if (result?.status) {
        setStatus(result.status)
        // The action answered with a status, which is what a success looks like
        // here. Clearing the error is the other half of that: left standing, the
        // red line from the previous failure reads as a verdict on this one, and
        // the user is told an action that worked had failed.
        setError("")
      } else {
        // The fallback read gets a signal of its own, and the one from the press
        // before it is dropped: two reads racing would let the older answer land
        // last, and on unmount there would be nothing to abort at all.
        runController.current?.abort()
        const controller = new AbortController()
        runController.current = controller
        await load(controller.signal)
      }
      // Only a smoke answers with `timedOut`; any other action clears the note, so a
      // re-run that really did finish does not leave the previous timeout on screen.
      setSmokeTimedOut(result?.timedOut === true)
      // What the action could not finish, said rather than dropped: a destroy that
      // docker refused answers with a warning instead of raising, and without this
      // the containers simply stay on the card with nothing explaining why.
      //
      // Only an action that answered replaces it. An action that answered with no
      // warning clears it - the press that produced the last one has been superseded,
      // and a line still standing over a teardown that has since worked reads as a
      // failure that is not there. A plain refresh answers with nothing to paint, so
      // it leaves the last answer standing rather than blanking a fact that is still
      // true: the containers are still listed, and the reason still explains them.
      if (result !== undefined) setWarning("warning" in result && result.warning ? hostWarningText(t, result.warning) : "")
      // An action that answered with the gate has just changed what the finish
      // waits for, so its answer replaces the last one; an action that did not
      // (a destroy, a plain refresh) leaves the previous answer standing rather
      // than blanking a fact that is still true.
      if (result && "gate" in result) setGate(result.gate ?? null)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setWorking(false)
    }
  }

  function onDestroyPress() {
    if (!armingDestroy) {
      setArmingDestroy(true)
      if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
      disarmTimer.current = setTimeout(() => setArmingDestroy(false), 4000)
      return
    }
    setArmingDestroy(false)
    run(() => api.destroyDeployment(path))
  }

  if (failed || status === null) return null
  const containers = status.containers.length > 0
  if (status.target === "none" && !status.stateFound && !containers) return null
  // A policy that deploys nothing offers no deployment to start or smoke - the Host refuses
  // both - but the space can still hold containers from a deploy made outside this flow, so the
  // card keeps showing them and keeps the one action that stays meaningful: tearing them down.
  const deploys = status.target !== "none"

  const smoke = status.lastSmoke
  const smokeBadge = smoke?.result === "pass"
    ? { cls: "dws-status-clean", label: t("deploySmokePass") }
    : smoke?.result === "fail"
      ? { cls: "dws-status-unavailable", label: t("deploySmokeFail") }
      : { cls: "dws-status-checking", label: t("deploySmokeNone") }
  // Read through the guard rather than straight off the status: a Host older than the
  // one that added it still forwards the state file's `url` as it came, and this
  // component has no error boundary above it - an object here would throw during
  // render and unmount the whole settings page rather than paint a blank row.
  const url = acceptanceUrl(status.url)

  return <div className="dws-deploy">
    <div className="dws-deploy-head">
      <span className="dws-deploy-title">{t("deployTitle")}</span>
      <span className="dws-deploy-env" title={status.envId}>{status.envId}</span>
      {containers ? <span className="dws-deploy-containers">{format(t("deployContainers"), { count: String(status.containers.length) })}</span> : null}
      <Button className="dws-button-ghost dws-deploy-refresh" disabled={working} aria-label={t("deployRefresh")} title={t("deployRefresh")} onClick={() => run(() => Promise.resolve())}><RefreshCw size={13} /></Button>
    </div>
    {/* The smoke is the whole of the acceptance record now: it is what the finish
        gate reads, and a green one is the verdict. There used to be a second badge
        here for a human acceptance ack the policy could wait for; that gate is gone,
        so the row says one thing rather than two that disagreed. */}
    <div className="dws-deploy-badges">
      <span className={`dws-status ${smokeBadge.cls}`} title={stamp(smoke?.at) || undefined}><span className="dws-status-dot" />{smokeBadge.label}{smoke?.at ? ` ${stamp(smoke.at)}` : ""}</span>
    </div>
    {/* What a finish would still refuse over, said here rather than at the finish.
        Only shown when the last deploy or smoke answered it and something is in
        fact missing: a policy with no gate, or one already satisfied, has nothing
        to say and gets no line. */}
    {gate !== null && gate.applies && gate.missing.length > 0
      ? <div className="dws-deploy-gate">
        <span className="dws-deploy-muted">{format(t("deployGateWaiting"), { missing: gateMissingText(t, gate.missing) })}</span>
      </div>
      : null}
    <div className="dws-deploy-row">
      <span className="dws-deploy-label">{t("deployUrlLabel")}</span>
      {url
        ? <a className="dws-deploy-url" href={url} target="_blank" rel="noreferrer" title={t("deployOpen")}>{url}</a>
        : <span className="dws-deploy-muted">{t("deployNoUrl")}</span>}
      <div className="dws-deploy-actions">
        {deploys && containers
          ? <Button className="dws-button-ghost dws-deploy-run-smoke" disabled={working} title={t("deploySmoke")} onClick={() => run(() => api.deploySmoke(path))}><RefreshCw size={14} /><span>{t("deploySmoke")}</span></Button>
          : null}
        {deploys && !containers
          ? <Button className="dws-button-ghost dws-deploy-up" disabled={working} title={t("deployUp")} onClick={() => run(() => api.deployUp(path))}><RefreshCw size={14} /><span>{t("deployUp")}</span></Button>
          : null}
        {containers
          ? <Button className={`dws-button-ghost dws-deploy-destroy${armingDestroy ? " dws-deploy-destroy-armed" : ""}`} disabled={working} title={t("deployDestroy")} onClick={onDestroyPress}><X size={14} /><span>{armingDestroy ? t("deployDestroyAgain") : t("deployDestroy")}</span></Button>
          : null}
      </div>
    </div>
    {/* Containers with nothing recorded is the shape that reads as "the panel is broken": name
        what is missing, who was supposed to write it, and what it costs. */}
    {containers && !status.stateFound
      ? <span className="dws-deploy-error">{t("deployStateMissing")}</span>
      : null}
    {/* A smoke this side stopped is not a smoke that failed, and saying so here is the
        only place that distinction can be made: the state file it would otherwise be
        read from was never written. */}
    {smokeTimedOut ? <span className="dws-deploy-error">{t("deploySmokeTimeout")}</span> : null}
    {error !== "" ? <span className="dws-deploy-error">{error}</span> : null}
    {/* A warning is not the red line above it: the action ran and this is what it
        left undone, so it wears the warning tone. The reason it exists at all is the
        one press whose failure was previously silent - destroy, refused by docker. */}
    {warning !== "" ? <span className="dws-deploy-warning" role="status">{warning}</span> : null}
  </div>
}
