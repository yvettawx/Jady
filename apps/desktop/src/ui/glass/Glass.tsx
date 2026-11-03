import { useEffect, useRef, type HTMLAttributes } from "react";
import { useGlass } from "./context";

/**
 * A liquid-glass panel: the shell's sidebars, the leftmost bar, widgets. Over the wallpaper or
 * the home scene the WebGL layer draws its refraction; elsewhere it falls back to CSS blur.
 *
 * Pass refract={false} for glass that scrolls with content, or that content can pass under:
 * the WebGL layer only paints the backdrop, and scrolling moves the page a frame before the
 * layer can follow, so such glass would show the text behind it unblurred or trail a ghost.
 */
export function Glass({
  refract = true,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  /** Off for glass over content or inside a scrolling area (see above). */
  refract?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { register, refracting } = useGlass();
  useEffect(() => (ref.current ? register(ref.current) : undefined), [register]);
  return (
    <div
      {...rest}
      ref={ref}
      className={className ? `dem-glass ${className}` : "dem-glass"}
      data-refract={(refract && refracting) || undefined}
      data-glass-refract={refract || undefined}
    />
  );
}
