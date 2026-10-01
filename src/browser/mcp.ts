import { Validator, type McpServerDefinition } from "@plurnk/plurnk-contracts";
import { runBrowserAction, type BrowserActionTarget } from "./action.ts";

export const listMcp = async (target: BrowserActionTarget) => {
  const result = Validator.assertFunctionalityListResult(await runBrowserAction(target, "workspace.mcp.list"));
  return {
    ...result,
    definitions: result.definitions.map(({ definition, ...entry }) => ({
      ...entry,
      ...(definition === undefined ? {} : { definition: Validator.assertMcpServerDefinition(definition as McpServerDefinition) }),
    })),
  };
};

export const discoverMcp = async (target: BrowserActionTarget, query: string) => {
  const result = Validator.assertFunctionalityDiscoverResult(await runBrowserAction(target, "workspace.mcp.discover", { query }));
  return {
    ...result,
    candidates: result.candidates.map(({ definition, ...candidate }) => ({
      ...candidate,
      definition: Validator.assertMcpServerDefinition(definition as McpServerDefinition),
    })),
  };
};

type McpMutation =
  | { verb: "add"; alias?: string; definition: McpServerDefinition }
  | { verb: "enable" | "disable" | "remove"; alias: string };

export const mutateMcp = async (target: BrowserActionTarget, { verb, ...params }: McpMutation) =>
  Validator.assertFunctionalityMutationResult(await runBrowserAction(target, `workspace.mcp.${verb}`, params));
