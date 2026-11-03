import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkspaceApi } from "../workspace/api";
import { sideColumns, useColumnFolding } from "./folding";

function fakeWorkspace(columns: number) {
  const visible = Array.from({ length: columns }, () => true);
  const listeners = new Set<() => void>();
  const ws = {
    shape: () => ({ columns, rows: visible.map(() => 1) }),
    isColumnVisible: (c: number) => visible[c] ?? false,
    setColumnVisible: (c: number, v: boolean) => {
      visible[c] = v;
      listeners.forEach((f) => f());
    },
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    fitColumns: () => {},
  } as unknown as WorkspaceApi;
  return { ws, visible };
}

describe("folding columns", () => {
  it("names the side columns by count", () => {
    expect(sideColumns(3)).toEqual({ left: 0, right: 2 });
    expect(sideColumns(2)).toEqual({ left: 0 });
    expect(sideColumns(1)).toEqual({});
  });

  it("folds the right column first, then the left, as the window narrows", () => {
    const { ws, visible } = fakeWorkspace(3);
    const { rerender } = renderHook(({ w }) => useColumnFolding(ws, w), {
      initialProps: { w: 1200 },
    });
    expect(visible).toEqual([true, true, true]);
    rerender({ w: 800 });
    expect(visible).toEqual([true, true, false]);
    rerender({ w: 500 });
    expect(visible).toEqual([false, true, false]);
    rerender({ w: 1200 });
    expect(visible).toEqual([true, true, true]);
  });

  it("keeps a hand toggle until the width crosses a threshold", () => {
    const { ws, visible } = fakeWorkspace(3);
    const { result, rerender } = renderHook(({ w }) => useColumnFolding(ws, w), {
      initialProps: { w: 800 },
    });
    expect(result.current.folded.right).toBe(true);
    act(() => result.current.toggle("right"));
    expect(visible[2]).toBe(true);
    rerender({ w: 820 });
    expect(visible[2]).toBe(true);
    act(() => result.current.toggle("left"));
    expect(visible[0]).toBe(false);
    rerender({ w: 1000 });
    expect(visible).toEqual([true, true, true]);
  });

  it("does not loop when a column cannot be shown yet (mid-load)", () => {
    const listeners = new Set<() => void>();
    let calls = 0;
    const ws = {
      shape: () => ({ columns: 3, rows: [1, 1, 1] }),
      isColumnVisible: () => false,
      setColumnVisible: () => {
        calls++;
        listeners.forEach((f) => f());
      },
      subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
      fitColumns: () => {},
    } as unknown as WorkspaceApi;
    renderHook(() => useColumnFolding(ws, 1200));
    expect(calls).toBeLessThan(10);
  });
});
