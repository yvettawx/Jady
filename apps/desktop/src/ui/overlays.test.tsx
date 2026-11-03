// Second batch of base components (P0.5-06-4): Esc closes, focus goes back where it was.
// React Aria restores focus on the next animation frame, hence waitFor.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { ConfirmDialog, Dialog, DialogActions, DialogTrigger } from "./Dialog";
import { ContextMenu, MenuButton, type MenuEntry } from "./Menu";
import { formatShortcut } from "./shortcut";
import { showToast, toastQueue } from "./toast";
import { ToastRegion } from "./Toasts";
import { Tooltip } from "./Tooltip";

const ITEMS: MenuEntry[] = [
  { id: "ask", label: "问 AI", icon: "ai", shortcut: "Mod+J" },
  { id: "translate", label: "翻译", icon: "translate" },
  {
    id: "ai-private",
    label: "问 AI（私密）",
    isDisabled: true,
    note: "私密内容，AI 看不到",
  },
  { kind: "separator", id: "s1" },
  {
    id: "move",
    label: "移到",
    children: [
      { id: "move-fr", label: "语言 / 法语" },
      { id: "move-inbox", label: "收集箱" },
    ],
  },
  { id: "delete", label: "删除", icon: "delete", danger: true },
];

describe("formatShortcut", () => {
  it("uses symbols on macOS and Ctrl elsewhere", () => {
    expect(formatShortcut("Mod+Shift+K", true)).toBe("⌘⇧K");
    expect(formatShortcut("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    expect(formatShortcut("Mod+Enter", true)).toBe("⌘↩");
  });
});

describe("MenuButton", () => {
  it("opens from the keyboard, runs an item and returns focus to the button", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<MenuButton items={ITEMS} onAction={onAction} aria-label="更多" />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: "更多" });
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(document.activeElement?.textContent).toContain("问 AI");
    expect(within(menu).getByText("私密内容，AI 看不到")).toBeDefined();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onAction).toHaveBeenCalledWith("translate");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("skips disabled items, opens submenus with ArrowRight and closes with Escape", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<MenuButton items={ITEMS} onAction={onAction} aria-label="更多" />);
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    // 问 AI → 翻译 → (disabled skipped) → 移到
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("移到");
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    expect(document.activeElement?.textContent).toContain("语言 / 法语");
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多" })),
    );
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("ContextMenu", () => {
  it("opens on right click and from Shift+F10, and Escape closes it", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu items={ITEMS} onAction={() => {}} aria-label="笔记的菜单">
        <p tabIndex={0}>第三章草稿</p>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("第三章草稿"), { clientX: 40, clientY: 50 });
    expect(await screen.findByRole("menu", { name: "笔记的菜单" })).toBeDefined();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.tab();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menu")).toBeDefined();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("第三章草稿"));
  });

  it("closes when an item is chosen", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ContextMenu items={ITEMS} onAction={onAction} aria-label="笔记的菜单">
        <p>第三章草稿</p>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("第三章草稿"), { clientX: 40, clientY: 50 });
    await user.click((await screen.findAllByRole("menuitem"))[0] as HTMLElement);
    expect(onAction).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("Dialog", () => {
  it("moves focus inside, closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <DialogTrigger>
        <Button>重命名</Button>
        <Dialog title="重命名空间">
          {({ close }) => (
            <DialogActions>
              <Button onPress={close}>完成</Button>
            </DialogActions>
          )}
        </Dialog>
      </DialogTrigger>,
    );
    await user.tab();
    const trigger = screen.getByRole("button", { name: "重命名" });
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "重命名空间" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("confirms only on the named button; Cancel has focus first", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen
        title="删除这条笔记？"
        message="删除后可以在回收站找回。"
        confirmLabel="删除"
        danger
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "删除这条笔记？" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" }));
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Tooltip", () => {
  it("shows the name and the shortcut on keyboard focus", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="搜索" shortcut="Mod+K">
        <Button icon="search" aria-label="搜索" />
      </Tooltip>,
    );
    await user.tab();
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("搜索");
    expect(tip.textContent).toMatch(/⌘K|Ctrl\+K/);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("toasts", () => {
  it("shows a toast with an action and a close button", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(<ToastRegion />);
    act(() => {
      showToast({ text: "已归档 3 条笔记", action: { label: "撤销", onAction: onUndo } });
    });
    expect(await screen.findByText("已归档 3 条笔记")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(screen.queryByText("已归档 3 条笔记")).toBeNull();

    act(() => {
      showToast({ text: "已保存" });
    });
    await user.click(await screen.findByRole("button", { name: "关闭" }));
    expect(screen.queryByText("已保存")).toBeNull();
    expect(toastQueue.visibleToasts).toHaveLength(0);
  });
});
