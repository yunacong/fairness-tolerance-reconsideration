import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@mui/material";
import { TradeoffChart } from "../src/components/TradeoffChart";
import { ViewCards } from "../src/components/ViewCards";
import { theme } from "../src/theme";
import type { ViewMetadata } from "../src/types";

const views: ViewMetadata[] = [
  { view_id: "C04", title: "Age x Demographic Parity", group_key: "age_25", group_label: "Age", group_a: "Age <= 25", group_b: "Age > 25", metric: "demographic_parity", metric_label: "Demographic Parity", description: "Compare Good Credit prediction rates." },
  { view_id: "C01", title: "Sex x Demographic Parity", group_key: "dataset_coded_sex", group_label: "Dataset-coded Sex", group_a: "Female", group_b: "Male", metric: "demographic_parity", metric_label: "Demographic Parity", description: "Compare Good Credit prediction rates." },
  { view_id: "C02", title: "Sex x Equal Opportunity", group_key: "dataset_coded_sex", group_label: "Dataset-coded Sex", group_a: "Female", group_b: "Male", metric: "equal_opportunity", metric_label: "Equal Opportunity", description: "Compare true-positive rates." },
];

function Harness() {
  const [value, setValue] = useState("");
  return <ViewCards views={views} value={value} onChange={setValue} />;
}

describe("Fairness View cards", () => {
  it("preserves server order, starts with no selection, and can be selected with the keyboard", async () => {
    const user = userEvent.setup();
    render(<ThemeProvider theme={theme}><Harness /></ThemeProvider>);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.getAllByText(/C0[124]/).map((node) => node.textContent)).toEqual(["C04", "C01", "C02"]);
    await user.tab();
    await user.keyboard(" ");
    expect(radios[0]).toBeChecked();
  });
});

describe("participant trade-off", () => {
  it("shows disparity and accuracy with an accessible table but no model cutoff", () => {
    const { container } = render(<ThemeProvider theme={theme}><TradeoffChart view={{ ...views[0]!, points: [
      { model_config_id: "MC-ABC12345", accuracy_pp: 78.5, fairness_disparity_pp: 6.25 },
      { model_config_id: "MC-DEF67890", accuracy_pp: 80, fairness_disparity_pp: 10 },
    ] }} /></ThemeProvider>);
    expect(screen.getByRole("img", { name: /fairness disparity and accuracy trade-off/i })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /accessible model configuration data/i })).toBeInTheDocument();
    expect(screen.getByText("6.25")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/classification cutoff/i);
  });
});
