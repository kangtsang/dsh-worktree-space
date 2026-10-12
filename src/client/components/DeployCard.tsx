import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw, X } from "./icons"
import { format, useT } from "../lib/i18n"
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
 * The gate's missing keys, said in the reader's language.
 *
 * Mapped explicitly rather than looked up by a built key, because a key the Host
 * adds later would then be printed raw: a name nobody translated is worse than the
 * Host's own English sentence, and this list is the one place that can notice.
 * An unrecognised key falls back to the Host's sentence through `t`'s own default
 * path - it is shown, not swallowed.
 */
function gateMissingText(t: (key: any) => string, missing: string[]) {
  const labels: Record<string, string> = {
    deployment: t("deployGateMissingDeployment"),
    smoke: t("deployGateMissingSmoke"),
  }
  return missing.map((key) => labels[key] ?? key).join(t("deployGateAnd"))
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
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  const [armingDestroy, setArmingDestroy] = useState(false)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next: DeploymentStatus = await api.deployStatus(path, { signal })
      setStatus(next)
      setFailed(false)
      setError("")
    } catch {
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

  // An armed destroy disarms itself, so a first press left alone means nothing.
  useEffect(() => () => { if (disarmTimer.current !== null) clearTimeout(disarmTimer.current) }, [])

  async function run(action: () => Promise<{ status?: DeploymentStatus } | unknown>) {
    setWorking(true)
    try {
      // Operations that ran a script answer with the live status already in hand
      // (the smoke's own verdict is in it, red included) - paint that, and only
      // fall back to a fresh read when the action returned nothing to paint.
      const result = await action() as { status?: DeploymentStatus; gate?: DeliveryGatePreview } | undefined
      if (result?.status) setStatus(result.status)
      else await load()
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
      {status.url
        ? <a className="dws-deploy-url" href={status.url} target="_blank" rel="noreferrer" title={t("deployOpen")}>{status.url}</a>
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
    {error !== "" ? <span className="dws-deploy-error">{error}</span> : null}
  </div>
}
