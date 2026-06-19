// Reusable, dependency-free UI primitives shared by every screen. Styled via
// the global.css component classes; dynamic values are applied inline. Names
// are stable contract: formatBytes, el, card, button, primaryButton,
// checkList, sizeBar, progressRing, toast, spinner, icon.

export { formatBytes } from "./format";
export { el, type Child, type ElProps } from "./dom";
export { card, type CardOptions } from "./card";
export {
  button,
  primaryButton,
  type ButtonOptions,
  type ButtonVariant,
  type ButtonHandle,
} from "./button";
export {
  checkList,
  type CheckItem,
  type CheckListOptions,
  type CheckListHandle,
} from "./checklist";
export { sizeBar, type SizeBarOptions, type SizeBarHandle } from "./sizebar";
export {
  progressRing,
  type ProgressRingOptions,
  type ProgressRingHandle,
} from "./ring";
export { toast, type ToastKind, type ToastOptions } from "./toast";
export { spinner, type SpinnerOptions } from "./spinner";
export { icon, type IconOptions } from "./icon";
