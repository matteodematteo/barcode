# Web Scanner native edition

This Capacitor wrapper keeps the existing Web Scanner screens and routes barcode capture through a local native plugin:

- iOS: AVFoundation metadata scanning with continuous autofocus, center metering, full-frame metadata detection, and a hardware zoom control.
- Android: CameraX live analysis with Google ML Kit barcode decoding, center AF/AE metering, latest-frame backpressure, and a zoom control.
- Web/PWA: the existing full-view ZXing path remains available, with camera zoom when exposed by the browser and a one-time-per-camera sharpness settling gate.

## Build the native project

Install Node 22+, Android Studio with Android SDK 36, and Xcode on macOS. From this directory run:

```sh
npm install
npm run sync
```

Open `android/` in Android Studio. On macOS, open the iOS project with `npm run open:ios` or open `ios/App/App.xcodeproj` in Xcode. The native scanner requests the operating-system camera permission on first use; the system remembers the decision for later launches.

The native scan view decodes the full camera image. The web zoom slider changes camera magnification only; it does not limit the decoder's search area. The web sharpness gate measures a small sample of the live preview once for each stream, then lets barcode decoding continue after focus stabilizes or a bounded 1.4-second wait.

The wrapper uses the same product lookup and history UI as the PWA. Native scan results re-enter the existing capture flow, so inventory and quantity behavior remains shared.
