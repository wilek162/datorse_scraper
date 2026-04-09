"use strict";

const { parseCliArgs, usageMessage } = require("../lib/run-source");

describe("run-source CLI", () => {
  test("parses source id and numeric overrides", () => {
    const parsed = parseCliArgs([
      "prisjakt",
      "--pageLimit",
      "1",
      "--itemLimit",
      "5",
    ]);

    expect(parsed).toEqual({
      sourceId: "prisjakt",
      overrides: { pageLimit: 1, itemLimit: 5 },
      help: false,
    });
  });

  test("supports alias flags and dry-run", () => {
    const parsed = parseCliArgs([
      "webhallen",
      "--page-limit",
      "2",
      "--item-limit",
      "10",
      "--dry-run",
    ]);

    expect(parsed).toEqual({
      sourceId: "webhallen",
      overrides: { pageLimit: 2, itemLimit: 10, dryRun: true },
      help: false,
    });
  });

  test("reports help and usage text", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(usageMessage()).toMatch(/itemLimit/i);
  });

  test("throws on unknown flags", () => {
    expect(() => parseCliArgs(["prisjakt", "--bogus"])).toThrow(
      /unknown argument/i,
    );
  });
});
