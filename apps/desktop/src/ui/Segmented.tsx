import { ToggleButton, ToggleButtonGroup, type Key } from "react-aria-components";
import "./segmented.css";

/** Pick one of two to five options, shown side by side (透明 / 着色). */
export function Segmented({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  options: { id: Key; label: string }[];
  value: Key;
  onChange: (id: Key) => void;
  "aria-label": string;
}) {
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      className="dem-segmented"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [first] = keys;
        if (first !== undefined) onChange(first);
      }}
    >
      {options.map((o) => (
        <ToggleButton key={o.id} id={o.id} className="dem-segment">
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
