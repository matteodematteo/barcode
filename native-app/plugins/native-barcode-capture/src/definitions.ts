export interface NativeScanResult {
  barcode?: string;
  format?: string;
  cancelled?: boolean;
}

export interface NativeBarcodeCapturePlugin {
  scan(options?: { formats?: string[] }): Promise<NativeScanResult>;
}
