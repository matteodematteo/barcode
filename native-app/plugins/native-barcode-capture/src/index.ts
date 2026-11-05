import { registerPlugin } from "@capacitor/core";
import type { NativeBarcodeCapturePlugin } from "./definitions";

export const NativeBarcodeCapture = registerPlugin<NativeBarcodeCapturePlugin>("NativeBarcodeCapture");
export * from "./definitions";
