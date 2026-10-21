import { expect, test } from "bun:test";
import { cleanTitle, TITLE_PROMPT } from "./hoy-title";

test("cleanTitle keeps the first line and strips quotes, labels and trailing periods", () => {
  expect(cleanTitle('"Postgres API connection."')).toBe("Postgres API connection");
  expect(cleanTitle("\n\nTitle: Debugging production 500 errors\nextra")).toBe("Debugging production 500 errors");
  expect(cleanTitle("“Dark mode toggle”")).toBe("Dark mode toggle");
});

test("cleanTitle swaps em dashes, caps the length, and rejects empty replies", () => {
  expect(cleanTitle("Fleet — queue order")).toBe("Fleet - queue order");
  const long = cleanTitle("x".repeat(80))!;
  expect(long.length).toBe(60);
  expect(long.endsWith("...")).toBe(true);
  expect(cleanTitle("   \n  ")).toBeNull();
});

test("the title prompt itself uses no em dashes", () => {
  expect(TITLE_PROMPT).not.toContain("—");
});
