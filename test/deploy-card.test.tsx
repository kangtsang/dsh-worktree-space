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
  urlSource: "state",
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

  it("offers no deploy or smoke action for a policy that deploys nothing, but still tears down and accepts", async () => {
    // Containers can stand in a space whose policy deploys nothing: someone deployed it outside
    // this flow. The Host refuses to start or smoke such a space, so the card must not offer
    // those two; teardown and the acceptance ack are what stay meaningful - the first because
    // nobody else can remove them, the second because it is the policy's own gate.
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ target: "none" })) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(screen.queryByRole("button", { name: t("deploySmoke") })).toBeNull()
    expect(screen.queryByRole("button", { name: t("deployUp") })).toBeNull()
    expect(screen.getByRole("button", { name: t("deployDestroy") })).toBeTruthy()
    expect(screen.getByRole("button", { name: t("deployAccept") })).toBeTruthy()
  })

  it("names what is missing when containers stand with nothing recorded", async () => {
    // The shape that reads as "the panel is broken": running containers, no URL, no smoke, and no
    // reason given. The card says who was supposed to write the state and what it costs.
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ stateFound: false, url: null, lastSmoke: null })) }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(container.textContent).toContain(t("deployStateMissing"))
    expect(container.textContent).toContain(t("deployNoUrl"))
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

  it("offers no fallback read while the state file is the one answering", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status()) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(screen.queryByRole("button", { name: t("deployDerive") })).toBeNull()
  })

  it("offers the fallback read when containers run with no state file", async () => {
    // The shape the fallback exists for: something is running, nothing recorded it,
    // and the deploy root may still answer for itself through its own status command.
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ stateFound: false, url: null, lastSmoke: null, urlSource: "none" })) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(screen.getByRole("button", { name: t("deployDerive") })).toBeTruthy()
  })

  it("labels a url that came from the script's own status output", async () => {
    // A derived URL is not a recorded deployment: the row says which of the two it
    // came from, and the press that bought it is not offered again.
    const api = {
      deployStatus: vi.fn()
        .mockResolvedValueOnce(status({ stateFound: false, url: null, lastSmoke: null, urlSource: "none" }))
        .mockResolvedValueOnce(status({ stateFound: false, url: "http://derived:51234", lastSmoke: null, urlSource: "derived" })),
    }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deployDerive") }))
    await waitFor(() => expect(screen.getByText("http://derived:51234")).toBeTruthy())
    expect(screen.getByText(t("deployUrlDerived"))).toBeTruthy()
    expect(screen.queryByRole("button", { name: t("deployDerive") })).toBeNull()
    expect(api.deployStatus).toHaveBeenLastCalledWith("/task", { derive: true })
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
