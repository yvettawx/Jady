import {
  Label,
  Slider as AriaSlider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  type SliderProps as AriaSliderProps,
} from "react-aria-components";
import "./field.css";
import "./slider.css";

export function Slider({
  label,
  showValue = false,
  ...rest
}: Omit<AriaSliderProps<number>, "className" | "style" | "children"> & {
  label?: string;
  showValue?: boolean;
}) {
  return (
    <AriaSlider {...rest} className="dem-slider">
      {(label || showValue) && (
        <div className="dem-slider-head">
          {label && <Label className="dem-field-label">{label}</Label>}
          {showValue && <SliderOutput className="dem-slider-value" />}
        </div>
      )}
      <SliderTrack className="dem-slider-track">
        {({ state }) => (
          <>
            <span
              className="dem-slider-fill"
              style={{ width: `${state.getThumbPercent(0) * 100}%` }}
            />
            <SliderThumb className="dem-slider-thumb" />
          </>
        )}
      </SliderTrack>
    </AriaSlider>
  );
}
