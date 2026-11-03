import {
  Button as AriaButton,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContentSlot,
  UNSTABLE_ToastRegion as AriaToastRegion,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import { toastQueue } from "./toast";
import "./overlay.css";
import "./toast.css";

/** Mount once near the root of the app. */
export function ToastRegion() {
  const t = useT();
  return (
    <AriaToastRegion queue={toastQueue} className="dem-toasts">
      {({ toast }) => (
        <Toast toast={toast} className="dem-toast" data-tone={toast.content.tone ?? "neutral"}>
          <ToastContentSlot className="dem-toast-content">
            <Text slot="title">{toast.content.text}</Text>
          </ToastContentSlot>
          {toast.content.action && (
            <AriaButton
              className="dem-toast-action"
              onPress={() => {
                toast.content.action?.onAction();
                toastQueue.close(toast.key);
              }}
            >
              {toast.content.action.label}
            </AriaButton>
          )}
          <AriaButton slot="close" className="dem-toast-close" aria-label={t("action.close")}>
            <Icon name="close" size={14} />
          </AriaButton>
        </Toast>
      )}
    </AriaToastRegion>
  );
}
