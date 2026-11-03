// First batch of base components (P0.5-06-3): keyboard use, accessible names, translated text.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { Badge, PrivacyMark, SourceMark } from "./Badge";
import { Button } from "./Button";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { Tags, type TagItem } from "./Tags";
import { TextField } from "./TextField";

describe("Button", () => {
  it("is reached with Tab and pressed with Enter or Space", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<Button onPress={onPress}>保存</Button>);
    await user.tab();
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toBe(document.activeElement);
    expect(button.hasAttribute("data-focus-visible")).toBe(true);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("names an icon-only button from aria-label and hides the icon", () => {
    render(<Button icon="close" aria-label="关闭" />);
    const button = screen.getByRole("button", { name: "关闭" });
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.hasAttribute("data-icon-only")).toBe(true);
  });

  it("does nothing while disabled", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(
      <Button isDisabled onPress={onPress}>
        保存
      </Button>,
    );
    await user.click(screen.getByRole("button"));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("Switch", () => {
  it("toggles with Space", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>减少透明度</Switch>);
    await user.tab();
    const sw = screen.getByRole("switch", { name: "减少透明度" });
    expect(sw).toBe(document.activeElement);
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect((sw as HTMLInputElement).checked).toBe(true);
  });
});

describe("TextField", () => {
  it("ties the label, hint and error to the input", async () => {
    const user = userEvent.setup();
    render(
      <TextField
        label="名称"
        description="中英文都可以"
        isRequired
        isInvalid
        errorMessage="请填写名称"
      />,
    );
    const input = screen.getByRole("textbox", { name: "名称" });
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual(
      expect.arrayContaining(["中英文都可以", "请填写名称"]),
    );
    await user.type(input, "法语 French");
    expect((input as HTMLInputElement).value).toBe("法语 French");
  });
});

describe("Select", () => {
  const options = [
    { id: "aurora", label: "极光" },
    { id: "ocean", label: "海洋" },
    { id: "forest", label: "森林" },
  ];

  function Harness() {
    const [value, setValue] = useState<string>("aurora");
    return (
      <>
        <Select
          label="配色方案"
          options={options}
          selectedKey={value}
          onSelectionChange={(k) => setValue(String(k))}
        />
        <output>{value}</output>
      </>
    );
  }

  it("opens from the keyboard, moves with arrows and picks with Enter", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: /配色方案/ });
    expect(trigger).toBe(document.activeElement);
    await user.keyboard("{ArrowDown}");
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["极光", "海洋", "森林"]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("status").textContent).toBe("ocean");
    expect(trigger.textContent).toBe("海洋");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("marks", () => {
  it("shows nothing for 普通 and the level with a lock otherwise", () => {
    const { container, rerender } = render(<PrivacyMark level="normal" />);
    expect(container.textContent).toBe("");
    rerender(<PrivacyMark level="private" />);
    expect(container.textContent).toBe("私密");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("translates privacy and source marks", () => {
    render(
      <I18nProvider locale="en">
        <PrivacyMark level="secret" />
        <SourceMark kind="aiSearch" />
        <Badge tone="ai">AI</Badge>
      </I18nProvider>,
    );
    expect(screen.getByText("Confidential")).toBeDefined();
    expect(screen.getByText("AI, from the web")).toBeDefined();
  });
});

describe("Tags", () => {
  it("removes a focused tag with Backspace and names the remove button", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [items, setItems] = useState<TagItem[]>([
        { id: "fr", label: "法语" },
        { id: "gr", label: "语法" },
      ]);
      return (
        <Tags
          aria-label="标签"
          items={items}
          onRemove={(ids) => setItems((xs) => xs.filter((x) => !ids.has(x.id)))}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "移除 法语" })).toBeDefined();
    await user.tab();
    expect(document.activeElement?.textContent).toContain("法语");
    await user.keyboard("{Backspace}");
    expect(screen.queryByText("法语")).toBeNull();
    expect(screen.getByText("语法")).toBeDefined();
  });
});
