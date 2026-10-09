import { useCallback, useEffect, useRef, useState } from "react"
import { Check, RefreshCw, X } from "./icons"
import { format, useT } from "../lib/i18n"
import { Button } from "./ui"
import type { DeploymentStatus } from "../lib/types"

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
 * smoke the deploy last ran, the human acceptance ack, and the actions under them.
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
  const [error, setError] = useState("")
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  const [armingDestroy, setArmingDestroy] = useState(false)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next: DeploymentStatus = await api.deployStatus(path, signal)
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
      const result = await action() as { status?: DeploymentStatus } | undefined
      if (result?.status) setStatus(result.status)
      else await load()
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
  // card keeps showing them and keeps the two actions that stay meaningful: tearing them down,
  // and the acceptance ack, which is the policy's own gate rather than the deployment's.
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
    <div className="dws-deploy-badges">
      <span className={`dws-status ${smokeBadge.cls}`} title={stamp(smoke?.at) || undefined}><span className="dws-status-dot" />{smokeBadge.label}{smoke?.at ? ` ${stamp(smoke.at)}` : ""}</span>
      {status.humanAck
        ? <span className="dws-status dws-status-clean" title={stamp(status.humanAck.at) || undefined}><span className="dws-status-dot" />{t("deployAcked")} {stamp(status.humanAck.at)}</span>
        : <span className="dws-status dws-status-checking"><span className="dws-status-dot" />{t("deployAckMissing")}</span>}
    </div>
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
        {status.stateFound && status.humanAck === null && status.url
          ? <Button className="dws-button-ghost dws-deploy-accept" disabled={working} title={t("deployAccept")} onClick={() => run(() => api.acceptDeployment(path))}><Check size={14} /><span>{t("deployAccept")}</span></Button>
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
