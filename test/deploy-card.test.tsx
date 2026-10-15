// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { DeployCard } from "../src/client/components/DeployCard"
import { format, t } from "../src/client/lib/i18n"

afterEach(cleanup)

/** The section reads on mount, so its answers arrive after the render. */
const settle = () => act(async () => {})

const status = (over = {}) => ({
  envId: "dsh-public-login",
  target: "docker",
  url: "http://localhost:51555",
  urlSource: "state",
  lastSmoke: { at: "2026-10-05T00:00:00Z", result: "pass" },
  destroyedAt: null,
  stateFound: true,
  statePath: "E:\\space\\.worktree-space\\deploy\\.state.json",
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

  it("offers no deploy or smoke action for a policy that deploys nothing, but still tears down", async () => {
    // Containers can stand in a space whose policy deploys nothing: someone deployed it outside
    // this flow. The Host refuses to start or smoke such a space, so the card must not offer
    // those two; teardown is what stays meaningful, because nobody else can remove them.
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ target: "none" })) }
    render(<DeployCard api={api} path="/task" />)
    await settle()
    expect(screen.queryByRole("button", { name: t("deploySmoke") })).toBeNull()
    expect(screen.queryByRole("button", { name: t("deployUp") })).toBeNull()
    expect(screen.getByRole("button", { name: t("deployDestroy") })).toBeTruthy()
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

  it("says a smoke was stopped at its deadline rather than presenting it as a failure", async () => {
    // A stopped smoke has no exit code and wrote no state, so the badge would go on
    // showing whatever the last completed run recorded - a red one from this side's own
    // timeout reads as a verdict on the environment, which it is not.
    const api = {
      deployStatus: vi.fn().mockResolvedValue(status()),
      deploySmoke: vi.fn().mockResolvedValue({ output: "…still running", exitCode: null, timedOut: true, status: status() }),
    }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deploySmoke") }))
    await waitFor(() => expect(container.textContent).toContain(t("deploySmokeTimeout")))
  })

  it("clears the timeout note when a later smoke really finishes", async () => {
    // The note belongs to one run: a re-run that answered must not leave the previous
    // timeout on screen, or the card would keep reporting a stop that is over.
    const api = {
      deployStatus: vi.fn().mockResolvedValue(status()),
      deploySmoke: vi.fn()
        .mockResolvedValueOnce({ output: "", exitCode: null, timedOut: true, status: status() })
        .mockResolvedValueOnce({ output: "ok", exitCode: 0, timedOut: false, status: status({ lastSmoke: { at: "2026-10-07T05:00:00Z", result: "pass" } }) }),
    }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deploySmoke") }))
    await waitFor(() => expect(container.textContent).toContain(t("deploySmokeTimeout")))
    fireEvent.click(screen.getByRole("button", { name: t("deploySmoke") }))
    await waitFor(() => expect(container.textContent).not.toContain(t("deploySmokeTimeout")))
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

  it("says why containers could not be destroyed, instead of leaving them unexplained", async () => {
    // The failure this exists for: docker refuses (permissions, a container in use),
    // the destroy answers with a warning rather than raising, and the containers stay
    // on the card. Without the warning the press reads as "clicked and nothing
    // happened" - the containers are still listed and nothing says why.
    const api = {
      deployStatus: vi.fn().mockResolvedValue(status()),
      destroyDeployment: vi.fn().mockResolvedValue({
        removed: false,
        containers: 2,
        warning: {
          code: "deploy-containers-left",
          message: "could not remove 2 containers of environment dsh-public-login: permission denied",
          values: { count: 2, envId: "dsh-public-login", reason: "permission denied" },
        },
      }),
    }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deployDestroy") }))
    fireEvent.click(screen.getByRole("button", { name: t("deployDestroyAgain") }))
    await waitFor(() => expect(api.destroyDeployment).toHaveBeenCalledWith("/task"))

    // The sentence is this plugin's own, built from the code and the values the Host
    // sent beside it - not the Host's English message, which is what the log keeps.
    await waitFor(() => expect(container.textContent).toContain(format(t("warnDeployContainersLeft"), {
      count: "2",
      envId: "dsh-public-login",
      reason: "permission denied",
    })))
    expect(container.textContent).not.toContain("could not remove 2 containers")
  })

  it("renders no warning line when the destroy answered with none", async () => {
    const api = {
      deployStatus: vi.fn().mockResolvedValue(status()),
      destroyDeployment: vi.fn().mockResolvedValue({ removed: true, containers: 2 }),
    }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: t("deployDestroy") }))
    fireEvent.click(screen.getByRole("button", { name: t("deployDestroyAgain") }))
    await waitFor(() => expect(api.destroyDeployment).toHaveBeenCalledWith("/task"))

    // A destroy that worked gets no line at all, rather than an empty one: the
    // warning element is only in the tree when there is something to say.
    expect(document.querySelector(".dws-deploy-warning")).toBeNull()
    expect(container.textContent).not.toContain(t("warnDeployContainersLeft").split("{")[0])
  })

  it("clears the previous failure when a later action succeeds", async () => {
    // A failed action leaves the red line, and the next action answering with a
    // status is what success looks like here. Left standing, the error reads as a
    // verdict on the action that just worked.
    const api = {
      deployStatus: vi.fn().mockResolvedValue(status()),
      deploySmoke: vi.fn()
        .mockRejectedValueOnce(new Error("docker is not running"))
        .mockResolvedValueOnce({ output: "step 5 ok", exitCode: 0, status: status() }),
    }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()

    fireEvent.click(screen.getByRole("button", { name: t("deploySmoke") }))
    await waitFor(() => expect(container.textContent).toContain("docker is not running"))

    fireEvent.click(screen.getByRole("button", { name: t("deploySmoke") }))
    await waitFor(() => expect(container.textContent).not.toContain("docker is not running"))
  })

  it("renders no link for a URL a state file should not have been able to produce", async () => {
    // The state file is the deploy script's, so `url` is whatever JSON it wrote. A Host
    // older than the fix in `deploy.js` still forwards that value as it came, and this
    // component is the last place it can be stopped: React refuses an object as a child,
    // the console registers no error boundary, and a throw here unmounts the whole
    // settings page. So the object case must *render*, and render without a link.
    const hostile = ["javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:msgbox(1)"]
    for (const url of hostile) {
      const api = { deployStatus: vi.fn().mockResolvedValue(status({ url })) }
      const { container, unmount } = render(<DeployCard api={api} path="/task" />)
      await settle()
      expect(container.querySelector("a.dws-deploy-url"), `url ${url}`).toBeNull()
      expect(container.textContent).toContain(t("deployNoUrl"))
      unmount()
    }
    // The non-string shape is the one that used to throw rather than paint: an object is
    // not a valid React child, so this assertion is about the render surviving at all.
    for (const url of [{ evil: true }, 42, true]) {
      const api = { deployStatus: vi.fn().mockResolvedValue(status({ url })) }
      const { container, unmount } = render(<DeployCard api={api} path="/task" />)
      await settle()
      expect(container.querySelector("a.dws-deploy-url"), `url ${JSON.stringify(url)}`).toBeNull()
      expect(container.textContent).toContain(t("deployNoUrl"))
      // The card is still a card: the sibling heading did not go with the page.
      expect(container.querySelector(".dws-deploy-head")).toBeTruthy()
      unmount()
    }
  })

  it("still opens an http acceptance URL the deploy recorded", async () => {
    const api = { deployStatus: vi.fn().mockResolvedValue(status({ url: "http://127.0.0.1:8080/" })) }
    const { container } = render(<DeployCard api={api} path="/task" />)
    await settle()
    const link = container.querySelector("a.dws-deploy-url") as HTMLAnchorElement | null
    expect(link).toBeTruthy()
    expect(link?.getAttribute("href")).toBe("http://127.0.0.1:8080/")
  })
})
