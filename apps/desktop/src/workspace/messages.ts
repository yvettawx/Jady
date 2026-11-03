// What dockview says to screen readers, in the interface language instead of its built-in English.
import type { Translate } from "../i18n/messages";

export function dockMessages(t: Translate) {
  const where = (kind: "edge" | "done", position: string, target: string) =>
    position === "center"
      ? t(`workspace.sr.${kind}.center`, { target })
      : t(`workspace.sr.${kind}.split`, {
          side: t(`workspace.sr.side.${position}`),
          target,
        });
  return {
    panelOpened: (title: string) => t("workspace.sr.opened", { title }),
    panelClosed: (title: string) => t("workspace.sr.closed", { title }),
    groupMaximized: (title: string) => t("workspace.sr.maximized", { title }),
    groupRestored: (title: string) => t("workspace.sr.restored", { title }),
    groupFloated: (title: string) => t("workspace.sr.floated", { title }),
    groupDocked: (title: string) => t("workspace.sr.docked", { title }),
    groupPoppedOut: (title: string) => t("workspace.sr.poppedOut", { title }),
    closeTab: (title: string) => t("tab.close", { title }),
    closeTabPlain: () => t("action.close"),
    movePickTarget: (source: string, target: string, current: number, total: number) =>
      t("workspace.sr.pickTarget", { source, target, current, total }),
    movePickEdge: (position: string, target: string) =>
      t("workspace.sr.pickEdge", { where: where("edge", position, target) }),
    moveCommitted: (source: string, target: string, position: string) =>
      t("workspace.sr.moved", { source, where: where("done", position, target) }),
    moveCancelled: () => t("workspace.sr.cancelled"),
    moveNotAllowed: () => t("workspace.sr.notAllowed"),
    moveFloated: (source: string) => t("workspace.sr.floated", { title: source }),
  };
}
