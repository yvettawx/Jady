import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import en from "./en.json";
import { useT } from "./context";
import { I18nProvider } from "./I18nProvider";
import { addMessages, translate } from "./messages";
import zhCN from "./zh-CN.json";

describe("messages", () => {
  it("has the same keys in every language", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it("fills in variables and falls back to the default language, then the key", () => {
    expect(translate("en", "tab.close", { title: "Notes" })).toBe("Close Notes");
    addMessages("zh-CN", { "test.only-zh": "只有中文" });
    expect(translate("en", "test.only-zh")).toBe("只有中文");
    expect(translate("en", "test.missing")).toBe("test.missing");
  });

  it("switches language through the provider", () => {
    const Label = () => <span>{useT()("action.close")}</span>;
    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <Label />
      </I18nProvider>,
    );
    expect(screen.getByText("关闭")).toBeDefined();
    rerender(
      <I18nProvider locale="en">
        <Label />
      </I18nProvider>,
    );
    expect(screen.getByText("Close")).toBeDefined();
  });
});
