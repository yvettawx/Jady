import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LibraryGate } from "./gate";
import { passwordStrength } from "./gate";
import { LibraryGateScreen } from "./LibraryGateScreen";
import { formatCode, groupCode, normalizeCode } from "./recoveryCode";

const CODE = "7K3MQ9TBXH2PWD5RNE8C4VJAFG6YSZ1T0M3Q";
const LIB = { name: "测试库", path: "/tmp/测试库" };

function fakeGate(over: Partial<LibraryGate> = {}): LibraryGate {
  return {
    defaultLocation: () => "/tmp",
    chooseFolder: async () => null,
    prepare: async () => ({ recoveryCode: CODE, commit: async () => {}, cancel: () => {} }),
    exportRecoveryCode: async () => {},
    keychainUnlock: async () => "unavailable",
    unlock: async (_l, pw) => (pw === "right" ? "ok" : "wrong"),
    recover: async (_l, code) => (code.startsWith("0000") ? "bad-code" : "ok"),
    ...over,
  };
}

describe("recovery code text", () => {
  it("ignores case, spaces and hyphens, reads I/L as 1 and O as 0", () => {
    expect(normalizeCode("7k3m q9tb-xhil o")).toBe("7K3MQ9TBXH110");
    expect(formatCode("7k3mq9tb")).toBe("7K3M-Q9TB");
    expect(groupCode(CODE)).toHaveLength(9);
    expect(normalizeCode(CODE + "EXTRA")).toHaveLength(36);
  });

  it("rates passwords roughly", () => {
    expect(passwordStrength("abc")).toBe("weak");
    expect(passwordStrength("Correct-horse-9")).toBe("strong");
  });
});

describe("create a library", () => {
  it("walks from welcome to an opened library, asking for two groups of the code", async () => {
    const user = userEvent.setup();
    const commit = vi.fn(async () => {});
    const onOpened = vi.fn();
    render(
      <LibraryGateScreen
        gate={fakeGate({ prepare: async () => ({ recoveryCode: CODE, commit, cancel: () => {} }) })}
        start={{ mode: "first-run" }}
        onOpened={onOpened}
      />,
    );
    await user.click(screen.getByRole("button", { name: "新建资料库" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.type(screen.getByLabelText("主密码"), "Correct-horse-9");
    await user.type(screen.getByLabelText("再输一次"), "Correct-horse-9");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    // The code is shown; Next stays off until the user says it is saved.
    expect(await screen.findByText("7K3M")).toBeDefined();
    const next = screen.getByRole("button", { name: "下一步" });
    expect(next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    await user.click(screen.getByText("我已经把恢复码存在安全的地方"));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    const [a = 0, b = 0] = (
      screen.getByText(/输入恢复码的第/).textContent?.match(/\d+/g) ?? []
    ).map(Number);
    const groups = groupCode(CODE);
    await user.type(screen.getByLabelText(`第 ${a} 组`), (groups[a - 1] ?? "").toLowerCase());
    await user.type(screen.getByLabelText(`第 ${b} 组`), groups[b - 1] ?? "");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(onOpened).toHaveBeenCalledWith({ name: "我的资料库", path: "/tmp" }),
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it("asks for at least 8 characters", async () => {
    const user = userEvent.setup();
    render(
      <LibraryGateScreen
        gate={fakeGate()}
        start={{ mode: "first-run" }}
        onOpened={() => {}}
        initialStep="password"
      />,
    );
    await user.type(screen.getByLabelText("主密码"), "法语学习abc");
    await user.type(screen.getByLabelText("再输一次"), "法语学习abc");
    expect(screen.getByText("至少 8 个字符")).toBeDefined();
    const next = screen.getByRole("button", { name: "下一步" });
    expect(next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    await user.type(screen.getByLabelText("主密码"), "d");
    await user.type(screen.getByLabelText("再输一次"), "d");
    expect(screen.queryByText("至少 8 个字符")).toBeNull();
  });

  it("will not go on while the two passwords differ", async () => {
    const user = userEvent.setup();
    render(
      <LibraryGateScreen
        gate={fakeGate()}
        start={{ mode: "first-run" }}
        onOpened={() => {}}
        initialStep="password"
      />,
    );
    await user.type(screen.getByLabelText("主密码"), "abcdefgh");
    await user.type(screen.getByLabelText("再输一次"), "abcdefgx");
    expect(screen.getByText("两次输入不一样")).toBeDefined();
    const next = screen.getByRole("button", { name: "下一步" });
    expect(next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
  });
});

describe("unlock", () => {
  it("falls back to the password when the keychain is unavailable, and says so", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    render(
      <LibraryGateScreen
        gate={fakeGate()}
        start={{ mode: "unlock", library: LIB }}
        onOpened={onOpened}
      />,
    );
    expect(await screen.findByText("钥匙串没有响应，输入主密码解锁。")).toBeDefined();
    await user.type(screen.getByLabelText("主密码"), "wrong");
    await user.click(screen.getByRole("button", { name: "解锁" }));
    expect(await screen.findByText("主密码不对")).toBeDefined();
    await user.clear(screen.getByLabelText("主密码"));
    await user.type(screen.getByLabelText("主密码"), "right");
    await user.click(screen.getByRole("button", { name: "解锁" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(LIB));
  });

  it("opens straight away when the keychain answers", async () => {
    const onOpened = vi.fn();
    render(
      <LibraryGateScreen
        gate={fakeGate({ keychainUnlock: async () => "ok" })}
        start={{ mode: "unlock", library: LIB }}
        onOpened={onOpened}
      />,
    );
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(LIB));
  });

  it("recovers with the code and a new password; a wrong code is refused", async () => {
    const user = userEvent.setup();
    const onOpened = vi.fn();
    render(
      <LibraryGateScreen
        gate={fakeGate()}
        start={{ mode: "unlock", library: LIB }}
        onOpened={onOpened}
        initialStep="recover"
      />,
    );
    const field = screen.getByLabelText("恢复码");
    await user.type(field, "0000" + CODE.slice(4));
    expect((field as HTMLInputElement).value).toMatch(/^0000-/);
    await user.type(screen.getByLabelText("新的主密码"), "new-pass-123");
    await user.type(screen.getByLabelText("再输一次"), "new-pass-123");
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(await screen.findByText("恢复码有一处不对，检查一下")).toBeDefined();
    await user.clear(field);
    await user.type(field, CODE);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(LIB));
  });
});
