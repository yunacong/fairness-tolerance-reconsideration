export type Step = "information" | "consent" | "background" | "tutorial" | "scenario" | "orientation" | "views" | "pre" | "tradeoff" | "comprehension" | "post" | "nasa_tlx" | "sus" | "finish";

export type ViewMetadata = {
  view_id: string;
  title: string;
  group_key: string;
  group_label: string;
  group_a: string;
  group_b: string;
  metric: string;
  metric_label: string;
  description: string;
};

export type TradeoffView = ViewMetadata & {
  points: Array<{ model_config_id: string; accuracy_pp: number; fairness_disparity_pp: number }>;
};
