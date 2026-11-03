import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Button } from "./Button";
import "./overlay.css";
import "./dialog.css";

export { DialogTrigger } from "react-aria-components";

export type DialogProps = Omit<ModalOverlayProps, "className" | "style" | "children"> & {
  title: string;
  /** alertdialog for confirmations that interrupt. */
  role?: "dialog" | "alertdialog";
  children: ReactNode | ((opts: { close: () => void }) => ReactNode);
};

/** A modal dialog. Esc and a click outside close it (unless isDismissable is false). */
export function Dialog({ title, role, children, isDismissable = true, ...rest }: DialogProps) {
  return (
    <ModalOverlay {...rest} isDismissable={isDismissable} className="dem-modal-overlay">
      <Modal className="dem-modal">
        <AriaDialog className="dem-dialog" role={role}>
          {({ close }) => (
            <>
              <Heading slot="title" className="dem-dialog-title">
                {title}
              </Heading>
              {typeof children === "function" ? children({ close }) : children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="dem-dialog-actions">{children}</div>;
}

/**
 * Asks before something that cannot be undone, such as deleting. The confirm button names the
 * action ("删除"); Cancel has focus first, so Enter alone never confirms.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  ...rest
}: Omit<DialogProps, "children"> & {
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog title={title} role="alertdialog" {...rest}>
      {({ close }) => (
        <>
          <div className="dem-dialog-body">{message}</div>
          <DialogActions>
            <Button onPress={close} autoFocus>
              {t("action.cancel")}
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              onPress={() => {
                onConfirm();
                close();
              }}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
