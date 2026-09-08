import type { Ref } from "react";

// React's callback-cleanup return type contains a package-local unique symbol.
// Describe the public ref protocol structurally at a library boundary, then
// return a local React ref without carrying that foreign nominal type through.
type CompatibleRefInput<T> =
  | ((instance: T | null) => void | (() => unknown))
  | { current: T | null }
  | null
  | undefined;

export function adaptReactRef<T>(
  ref: CompatibleRefInput<T>,
): Ref<T> | undefined {
  if (typeof ref !== "function") return ref;
  return (instance) => {
    const cleanup = ref(instance);
    if (typeof cleanup === "function") {
      return () => {
        cleanup();
      };
    }
  };
}
