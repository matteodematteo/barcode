package com.mattoteo.nativebarcode;

import android.Manifest;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.Size;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.Barcode;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.common.InputImage;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativeBarcodeCapture", permissions = {
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class NativeBarcodeCapturePlugin extends Plugin {
    private PluginCall scanCall;
    private Dialog scanDialog;
    private NativeScanView scanView;

    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionResult");
            return;
        }
        openScanner(call);
    }

    @PermissionCallback
    private void cameraPermissionResult(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission was not granted.", "PERMISSION_DENIED");
            return;
        }
        openScanner(call);
    }

    private void openScanner(PluginCall call) {
        if (scanCall != null) {
            call.reject("A native scan is already active.", "SCAN_ACTIVE");
            return;
        }
        getActivity().runOnUiThread(() -> {
            scanCall = call;
            call.setKeepAlive(true);
            scanDialog = new Dialog(getActivity(), android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            scanView = new NativeScanView(getActivity(), (LifecycleOwner) getActivity(), this::finishScan);
            scanDialog.setContentView(scanView);
            Window window = scanDialog.getWindow();
            if (window != null) {
                window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
                window.setStatusBarColor(Color.BLACK);
                window.setNavigationBarColor(Color.BLACK);
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            scanDialog.setOnCancelListener(ignored -> finishScan(null, null, true));
            scanDialog.show();
        });
    }

    private void finishScan(String value, String format, boolean cancelled) {
        getActivity().runOnUiThread(() -> {
            PluginCall call = scanCall;
            scanCall = null;
            if (scanView != null) scanView.shutdown();
            scanView = null;
            if (scanDialog != null && scanDialog.isShowing()) scanDialog.dismiss();
            scanDialog = null;
            if (call == null) return;
            JSObject result = new JSObject();
            result.put("cancelled", cancelled);
            if (value != null) result.put("barcode", value);
            if (format != null) result.put("format", format);
            call.resolve(result);
        });
    }

    private interface ScanResult { void complete(String value, String format, boolean cancelled); }

    private static final class NativeScanView extends FrameLayout {
        private final PreviewView preview;
        private final LifecycleOwner lifecycleOwner;
        private final ScanResult result;
        private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();
        private final BarcodeScanner scanner;
        private final AtomicBoolean finished = new AtomicBoolean(false);
        private ProcessCameraProvider provider;
        private Camera camera;
        private SeekBar zoomBar;
        private TextView zoomLabel;
        private float minZoom = 1f;
        private float maxZoom = 1f;

        NativeScanView(Context context, LifecycleOwner lifecycleOwner, ScanResult result) {
            super(context);
            this.lifecycleOwner = lifecycleOwner;
            this.result = result;
            setBackgroundColor(Color.BLACK);
            preview = new PreviewView(context);
            preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
            preview.setOnTouchListener((view, event) -> {
                if (event.getAction() != MotionEvent.ACTION_UP || camera == null) return false;
                try {
                    FocusMeteringAction action = new FocusMeteringAction.Builder(
                        preview.getMeteringPointFactory().createPoint(event.getX(), event.getY()),
                        FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                        .setAutoCancelDuration(5, TimeUnit.SECONDS).build();
                    camera.getCameraControl().startFocusAndMetering(action);
                } catch (RuntimeException ignored) {
                    // Keep scanning when a camera does not support point focus.
                }
                return false;
            });
            addView(preview, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

            BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A,
                    Barcode.FORMAT_UPC_E, Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39,
                    Barcode.FORMAT_CODE_93, Barcode.FORMAT_CODABAR, Barcode.FORMAT_ITF)
                .build();
            scanner = BarcodeScanning.getClient(options);
            addControls(context);
            bindCamera();
        }

        private void addControls(Context context) {
            LinearLayout top = new LinearLayout(context);
            top.setGravity(Gravity.CENTER_VERTICAL);
            top.setPadding(16, 20, 16, 12);
            top.setBackgroundColor(0x99000000);
            TextView title = new TextView(context);
            title.setText("Capture a barcode");
            title.setTextColor(Color.WHITE);
            title.setTextSize(20);
            title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            top.addView(title, new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
            Button close = new Button(context);
            close.setText("Close");
            close.setOnClickListener(v -> result.complete(null, null, true));
            top.addView(close);
            LayoutParams topParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP);
            addView(top, topParams);

            LinearLayout bottom = new LinearLayout(context);
            bottom.setOrientation(LinearLayout.VERTICAL);
            bottom.setPadding(20, 14, 20, 18);
            bottom.setBackgroundColor(0x99000000);
            TextView hint = new TextView(context);
            hint.setText("Tap the barcode to focus, then hold steady");
            hint.setTextColor(Color.WHITE);
            hint.setTextSize(16);
            bottom.addView(hint);
            LinearLayout zoomRow = new LinearLayout(context);
            zoomRow.setGravity(Gravity.CENTER_VERTICAL);
            zoomLabel = new TextView(context);
            zoomLabel.setText("1.0×");
            zoomLabel.setTextColor(Color.WHITE);
            zoomRow.addView(zoomLabel, new LinearLayout.LayoutParams(52, LayoutParams.WRAP_CONTENT));
            zoomBar = new SeekBar(context);
            zoomBar.setMax(1000);
            zoomBar.setProgress(0);
            zoomBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
                @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                    if (!fromUser || camera == null) return;
                    float ratio = minZoom + (maxZoom - minZoom) * progress / 1000f;
                    camera.getCameraControl().setZoomRatio(ratio);
                    zoomLabel.setText(String.format(java.util.Locale.US, "%.1f×", ratio));
                }
                @Override public void onStartTrackingTouch(SeekBar bar) {}
                @Override public void onStopTrackingTouch(SeekBar bar) {}
            });
            zoomRow.addView(zoomBar, new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
            bottom.addView(zoomRow);
            LayoutParams bottomParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
            addView(bottom, bottomParams);
        }

        private void bindCamera() {
            ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(getContext());
            future.addListener(() -> {
                try {
                    provider = future.get();
                    Preview cameraPreview = new Preview.Builder().build();
                    cameraPreview.setSurfaceProvider(preview.getSurfaceProvider());
                    ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setTargetResolution(new Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();
                    analysis.setAnalyzer(analysisExecutor, this::analyze);
                    provider.unbindAll();
                    camera = provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA,
                        cameraPreview, analysis);
                    camera.getCameraInfo().getZoomState().observe(lifecycleOwner, zoom -> {
                        if (zoom == null) return;
                        minZoom = zoom.getMinZoomRatio(); maxZoom = Math.min(zoom.getMaxZoomRatio(), 5f);
                        zoomBar.setEnabled(maxZoom > minZoom);
                        zoomLabel.setText(String.format(java.util.Locale.US, "%.1f×", zoom.getZoomRatio()));
                    });
                    preview.post(() -> {
                        if (camera == null) return;
                        FocusMeteringAction action = new FocusMeteringAction.Builder(
                            preview.getMeteringPointFactory().createPoint(0.5f, 0.5f),
                            FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                            .setAutoCancelDuration(5, TimeUnit.SECONDS).build();
                        camera.getCameraControl().startFocusAndMetering(action);
                    });
                } catch (Exception error) {
                    result.complete(null, error.getMessage(), true);
                }
            }, ContextCompat.getMainExecutor(getContext()));
        }

        private void analyze(@NonNull ImageProxy proxy) {
            android.media.Image mediaImage = proxy.getImage();
            if (mediaImage == null || finished.get()) { proxy.close(); return; }
            InputImage image = InputImage.fromMediaImage(mediaImage, proxy.getImageInfo().getRotationDegrees());
            scanner.process(image).addOnSuccessListener(analysisExecutor, barcodes -> {
                for (Barcode barcode : barcodes) {
                    String value = barcode.getRawValue();
                    if (value != null && !value.isEmpty() && finished.compareAndSet(false, true)) {
                        result.complete(value, String.valueOf(barcode.getFormat()), false);
                        break;
                    }
                }
            }).addOnCompleteListener(analysisExecutor, task -> proxy.close());
        }

        void shutdown() {
            if (provider != null) provider.unbindAll();
            scanner.close();
            analysisExecutor.shutdownNow();
        }
    }
}
