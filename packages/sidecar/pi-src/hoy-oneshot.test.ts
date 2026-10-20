import { expect, test } from "bun:test";
import { disabledModels, pickOneShotModel } from "./hoy-oneshot";

const m = (provider: string, id: string, input: number, output: number) => ({ provider, id, cost: { input, output } });
const models = [m("meta", "big", 5, 15), m("meta", "small", 1, 2), m("anthropic", "haiku", 0.8, 4), m("openai", "nano", 0.1, 0.4)];

test("the cheapest model across every provider wins with no seed or pin", () => {
  expect(pickOneShotModel(models, {})?.id).toBe("nano");
});

test("disabled models are never picked, even when pinned", () => {
  const disabled = disabledModels("openai/nano\nmeta/small\n");
  expect(pickOneShotModel(models, { disabled })?.id).toBe("haiku");
  expect(pickOneShotModel(models, { pinned: "openai/nano", disabled })?.id).toBe("haiku");
});

test("a pin is used exactly; a seed narrows to the cheapest of its provider", () => {
  expect(pickOneShotModel(models, { pinned: "meta/big" })?.id).toBe("big");
  expect(pickOneShotModel(models, { seed: "meta/big" })?.id).toBe("small");
  expect(pickOneShotModel(models, { seed: "meta/big", disabled: new Set(["meta/small", "meta/big"]) })?.id).toBe("nano");
  expect(pickOneShotModel([], {})).toBeUndefined();
});
