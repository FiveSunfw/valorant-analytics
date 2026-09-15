import { createHash } from "node:crypto";

export type PromptAsset = {
  id: string;
  version: string;
  role: "system" | "router" | "synthesis";
  purpose: string;
  template: string;
  allowedTools: string[];
  forbiddenClaims: string[];
  budget: { maxSteps: number; maxToolCalls: number };
  changelog: string;
};

const assets: readonly PromptAsset[] = [
  {
    id: "agent.shared.policy",
    version: "1.1.0",
    role: "system",
    purpose: "Keep the analysis evidence-bound and within product scope.",
    template: [
      "You analyze only the authenticated player's completed competitive VALORANT data.",
      "Never request a PUUID, token, another player's data, or arbitrary SQL.",
      "Do not claim exact movement, crosshair position, intent, hidden MMR/ELO, or real-time advice unless evidence supports it.",
      "Every factual player claim must cite a returned metric or a specific match round. Explain small samples and missing data."
    ].join(" "),
    allowedTools: ["get_player_summary", "get_match_list", "get_match_detail", "compare_attack_defense", "compare_map_performance", "compare_recent_periods", "find_round_evidence", "get_round_evidence"],
    forbiddenClaims: ["hidden MMR/ELO", "pre-match scouting", "real-time coaching", "cheat assistance"],
    budget: { maxSteps: 4, maxToolCalls: 3 },
    changelog: "Add recent-period comparison to the shared tool allowlist."
  },
  {
    id: "agent.supervisor.system",
    version: "1.1.0",
    role: "system",
    purpose: "Run a single bounded analysis loop.",
    template: "Use the smallest number of registered tools needed to answer the player's question, then return the evidence-bound answer contract.",
    allowedTools: ["get_player_summary", "get_match_list", "get_match_detail", "compare_attack_defense", "compare_map_performance", "compare_recent_periods", "find_round_evidence", "get_round_evidence"],
    forbiddenClaims: ["unsupported telemetry", "another player's data"],
    budget: { maxSteps: 4, maxToolCalls: 3 },
    changelog: "Add recent-period comparison to the supervisor tool allowlist."
  }
];

export type RegisteredPrompt = PromptAsset & { hash: string };

export class PromptRegistry {
  private readonly byId = new Map(assets.map((asset) => [asset.id, asset]));

  get(id: string, version?: string): RegisteredPrompt {
    const asset = this.byId.get(id);
    if (!asset || (version && asset.version !== version)) throw new Error(`Prompt asset is not registered: ${id}@${version ?? "latest"}`);
    const hash = createHash("sha256").update(JSON.stringify(asset)).digest("hex");
    return { ...asset, hash };
  }

  list(): RegisteredPrompt[] {
    return assets.map((asset) => this.get(asset.id, asset.version));
  }
}

export const promptRegistry = new PromptRegistry();
