// Development builds let the probe find a day on screen.
declare global {
  interface Window {
    __heatLocate?: (index: number) => { x: number; y: number } | null;
  }
}

export {};
