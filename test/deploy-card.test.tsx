// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { DeployCard } from "../src/client/components/DeployCard"
import { t } from "../src/client/lib/i18n"

afterEach(cleanup)

/** The section reads on mount, so its answers arrive after the render. */
const settle = () => act(async () => {})

const status = (over = {}) => ({
  envId: "dsh-public-login",
  target: "docker",
  url: "http://localhost:51555",
  lastSmoke: { at: "2026-10-05T00:00:00Z", result: "pass" },
  humanAck: null,
  stateFound: true,
  statePath: "E:\\space\\deploy\\.state.json",
  containers: [{ name: "gw-1", state: "running" }, { name: "web-1", state: "running" }],
  ...over,
})

describe("the deployment card", () => {
  it("shows the acceptance url, the smoke badge and the container count", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status()) }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(await screen.findByText("http://localhost:51555")).toBeTruthy()
    // The badge carries the audit-log-format stamp beside its label.
    expect(screen.getByText(/冒烟通过 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)).toBeTruthy()
    expect(container.textContent).toContain(t("deployContainers").replace("{count}", "2"))
    expect(api.deployStatus).toHaveBeenCalledWith("/task", expect.anything())
  })

  it("hides itself entirely for a task whose policy deployed nothing", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ target: "none", url: null, stateFound: false, containers: [], lastSmoke: null })) }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(container.firstElementChild).toBeNull()
  })

  it("records the human acceptance through the api", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status()), acceptDeployment: vi.fn().mockResolvedValue({ statePath: "x", humanAck: { at: "2026-10-05T01:00:00Z" } }) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deployAccept") }))
    await waitFor(() => expect(api.acceptDeployment).toHaveBeenCalledWith("/task"))
  })

  it("offers the one-click rebuild once the environment is gone", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ containers: [], url: null })), deployUp: vi.fn().mockResolvedValue({ output: "up", status: status() }) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(screen.getByText(t("deployNoUrl"))).toBeTruthy()
    expect(api.deployUp).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: t("deployUp") }))
    await waitFor(() => expect(api.deployUp).toHaveBeenCalledWith("/task"))
  })

  it("re-runs the smoke and repaints from the result, failed or passed", async () => {
    // A failed smoke is a result: the api resolves with the fail badge in its
    // status, and the card shows it rather than surfacing an error.
    const api = { deployStatus: vi.fn().mockResolvedValue(status()), deploySmoke: vi.fn().mockResolvedValue({ output: "step 5 FAIL", exitCode: 1, status: status({ lastSmoke: { at: "2026-10-07T05:00:00Z", result: "fail" } }) }) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deploySmoke") }))
    await waitFor(() => expect(api.deploySmoke).toHaveBeenCalledWith("/task"))
    await waitFor(() => expect(screen.getByText(/冒烟失败 \d{4}-\d{2}-\d{2}/)).toBeTruthy())
  })

  it("destroys on the second press, not the first", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status()), destroyDeployment: vi.fn().mockResolvedValue({ removed: true, containers: 2 }) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    // The first press only arms the button - a console may suppress native
    // dialogs, and a suppressed confirm must not read as a confirmed destroy.
    fireEvent.click(screen.getByRole("button", { name: t("deployDestroy") }))
    expect(screen.getByRole("button", { name: t("deployDestroyAgain") })).toBeTruthy()
    expect(api.destroyDeployment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: t("deployDestroyAgain") }))
    await waitFor(() => expect(api.destroyDeployment).toHaveBeenCalledWith("/task"))
  })
})
