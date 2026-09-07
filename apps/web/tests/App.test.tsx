import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, isLocalResearcherHost } from "../src/App";
import { theme } from "../src/theme";

const PARTICIPANT_ID = "P-111111111111";
const SESSION_ID = "S-222222222222";

function completedSessionResponse() {
  return new Response(JSON.stringify({
    participant_id: PARTICIPANT_ID,
    session_id: SESSION_ID,
    current_step: "finish",
    status: "completed",
    completion_code: "FAIR-AAAA-BBBB",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function seedCompletedSession() {
  window.localStorage.setItem("fairness_participant_id", PARTICIPANT_ID);
  window.localStorage.setItem("fairness_session_id", SESSION_ID);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("local researcher control", () => {
  it("is limited to localhost and 127.0.0.1", () => {
    expect(isLocalResearcherHost("localhost")).toBe(true);
    expect(isLocalResearcherHost("127.0.0.1")).toBe(true);
    expect(isLocalResearcherHost("study.example.org")).toBe(false);
    expect(isLocalResearcherHost("192.168.1.10")).toBe(false);
  });

  it("does not expose the control on a public host", async () => {
    seedCompletedSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(completedSessionResponse());

    render(<ThemeProvider theme={theme}><App hostname="study.example.org" /></ThemeProvider>);

    expect(await screen.findByRole("heading", { name: "Study complete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start next participant" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Local researcher control")).not.toBeInTheDocument();
  });

  it("keeps the completed session on cancel, then clears only browser identity and returns to information on confirm", async () => {
    const user = userEvent.setup();
    seedCompletedSession();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(completedSessionResponse());
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<ThemeProvider theme={theme}><App hostname="localhost" /></ThemeProvider>);

    const button = await screen.findByRole("button", { name: "Start next participant" });
    expect(screen.getByText(/completed data remains saved/i)).toBeInTheDocument();

    await user.click(button);
    expect(confirmMock).toHaveBeenLastCalledWith("Start a new participant on this device? The completed participant data will remain saved.");
    expect(window.localStorage.getItem("fairness_participant_id")).toBe(PARTICIPANT_ID);
    expect(window.localStorage.getItem("fairness_session_id")).toBe(SESSION_ID);
    expect(screen.getByRole("heading", { name: "Study complete" })).toBeInTheDocument();

    await user.click(button);
    await waitFor(() => expect(screen.getByRole("heading", { name: /How do people judge fairness/i })).toBeInTheDocument());
    expect(window.localStorage.getItem("fairness_participant_id")).toBeNull();
    expect(window.localStorage.getItem("fairness_session_id")).toBeNull();
    expect(screen.queryByText("FAIR-AAAA-BBBB")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`Anonymous participant ${PARTICIPANT_ID}`)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});
