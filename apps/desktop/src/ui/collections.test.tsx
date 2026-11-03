// Third batch of base components (P0.5-06-5): tabs, list and tree rows, tables, states.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { SortDescriptor } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";
import { ContentTab } from "./ContentTab";
import { DataTable, type TableColumn } from "./DataTable";
import { List, ListItem } from "./List";
import { EmptyState, Spinner } from "./States";
import { Tree, type TreeNode } from "./Tree";

describe("ContentTab", () => {
  it("draws the three kinds; a pinned tab has no close button", () => {
    const { rerender } = render(<ContentTab title="首页" kind="pin" onClose={() => {}} />);
    expect(screen.getByRole("img", { name: "已固定" })).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ContentTab title="第三章草稿" kind="preview" onClose={() => {}} />);
    expect(screen.getByText("第三章草稿").closest("[data-kind]")?.getAttribute("data-kind")).toBe(
      "preview",
    );
  });

  it("closes from its button and from a middle click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContentTab title="第 12 课" onClose={onClose} session="auth" />);
    expect(screen.getByRole("img", { name: "授权对话" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "关闭 第 12 课" }));
    fireEvent(
      screen.getByText("第 12 课"),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("List", () => {
  it("moves with arrow keys and opens a row with Enter", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const items = [
      { id: "a", title: "第 11 课" },
      { id: "b", title: "第 12 课" },
    ];
    render(
      <List aria-label="笔记" items={items} onAction={onAction}>
        {(it) => <ListItem id={it.id} textValue={it.title} icon="file" title={it.title} />}
      </List>,
    );
    await user.tab();
    expect(document.activeElement?.textContent).toContain("第 11 课");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onAction).toHaveBeenCalledWith("b");
  });

  it("shows the empty state when there are no rows", () => {
    render(
      <List
        aria-label="笔记"
        items={[] as { id: string }[]}
        renderEmptyState={() => <EmptyState icon="inbox" title="收集箱是空的" />}
      >
        {(it) => <ListItem id={it.id} textValue="" title="" />}
      </List>,
    );
    expect(screen.getByText("收集箱是空的")).toBeDefined();
  });
});

describe("Tree", () => {
  const ITEMS: TreeNode[] = [
    {
      id: "lang",
      label: "语言",
      icon: "folder",
      children: [
        { id: "fr", label: "法语", icon: "folder", children: [{ id: "l12", label: "第 12 课" }] },
        { id: "jp", label: "日语", icon: "folder" },
      ],
    },
    { id: "inbox", label: "收集箱", icon: "inbox" },
  ];

  it("expands with ArrowRight, collapses with ArrowLeft and opens with Enter", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Tree aria-label="目录" items={ITEMS} onAction={onAction} />);
    const tree = screen.getByRole("treegrid");
    expect(within(tree).queryByText("法语")).toBeNull();
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(within(tree).getByText("法语")).toBeDefined();
    expect(screen.getByRole("row", { name: "语言" }).getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("第 12 课");
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledWith("l12");
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(within(tree).queryByText("第 12 课")).toBeNull();
  });
});

describe("DataTable", () => {
  type Row = { id: string; word: string; reviews: number };
  const columns: TableColumn<Row>[] = [
    { id: "word", label: "单词", isRowHeader: true, allowsSorting: true },
    { id: "reviews", label: "复习次数", numeric: true, allowsSorting: true },
  ];

  it("sorts from a header click and marks numeric cells", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [sort, setSort] = useState<SortDescriptor>({ column: "word", direction: "ascending" });
      const rows = [
        { id: "1", word: "bonjour", reviews: 12 },
        { id: "2", word: "merci", reviews: 3 },
      ].sort((a, b) => {
        const k = sort.column as keyof Row;
        const d = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0;
        return sort.direction === "ascending" ? d : -d;
      });
      return (
        <DataTable
          aria-label="单词"
          columns={columns}
          rows={rows}
          sortDescriptor={sort}
          onSortChange={setSort}
        />
      );
    }
    render(<Harness />);
    const firstWord = () => screen.getAllByRole("rowheader")[0]?.textContent;
    expect(firstWord()).toBe("bonjour");
    await user.click(screen.getByRole("columnheader", { name: /单词/ }));
    expect(firstWord()).toBe("merci");
    expect(screen.getByText("12").getAttribute("data-numeric")).toBe("true");
  });

  it("shows the empty state", () => {
    render(
      <DataTable
        aria-label="单词"
        columns={columns}
        rows={[]}
        empty={<EmptyState title="还没有单词" />}
      />,
    );
    expect(screen.getByText("还没有单词")).toBeDefined();
  });
});

describe("Spinner", () => {
  it("is an indeterminate progress bar named in the current language", () => {
    render(<Spinner />);
    const bar = screen.getByRole("progressbar", { name: "正在加载" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });
});
