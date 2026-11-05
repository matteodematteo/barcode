import AVFoundation
import Capacitor
import UIKit

@objc(NativeBarcodeCapturePlugin)
public class NativeBarcodeCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBarcodeCapturePlugin"
    public let jsName = "NativeBarcodeCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    @objc func scan(_ call: CAPPluginCall) {
        call.keepAlive = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            presentScanner(call)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted { self.presentScanner(call) }
                    else { call.reject("Camera permission was not granted.", "PERMISSION_DENIED") }
                }
            }
        default:
            call.reject("Enable camera access in iPhone Settings to scan barcodes.", "PERMISSION_DENIED")
        }
    }

    private func presentScanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                call.reject("The native scanner could not open.", "SCANNER_UNAVAILABLE")
                return
            }
            let controller = NativeBarcodeScannerViewController()
            controller.onComplete = { [weak controller] result in
                controller?.dismiss(animated: true) {
                    if let message = result["error"] as? String {
                        call.reject(message, "SCANNER_UNAVAILABLE")
                    } else {
                        call.resolve(result)
                    }
                }
            }
            controller.onCancel = { [weak controller] in
                controller?.dismiss(animated: true) {
                    call.resolve(["cancelled": true])
                }
            }
            controller.modalPresentationStyle = .fullScreen
            presenter.present(controller, animated: true)
        }
    }
}

private final class NativeBarcodeScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onComplete: ((JSObject) -> Void)?
    var onCancel: (() -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "webscanner.native-camera")
    private let preview = AVCaptureVideoPreviewLayer()
    private let status = UILabel()
    private let zoomSlider = UISlider()
    private let zoomLabel = UILabel()
    private var device: AVCaptureDevice?
    private var metadataOutput: AVCaptureMetadataOutput?
    private var isConfigured = false
    private var isFinished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildControls()
        let focusTap = UITapGestureRecognizer(target: self, action: #selector(focusAtTap(_:)))
        focusTap.cancelsTouchesInView = false
        view.addGestureRecognizer(focusTap)
        configureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [weak self] in
            guard let self, self.isConfigured, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    private func buildControls() {
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        let header = UIView()
        header.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)

        let title = UILabel()
        title.text = "Capture a barcode"
        title.font = .boldSystemFont(ofSize: 20)
        title.textColor = .white
        title.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(title)

        let close = UIButton(type: .system)
        close.setTitle("Close", for: .normal)
        close.tintColor = .white
        close.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        close.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(close)

        let footer = UIStackView()
        footer.axis = .vertical
        footer.spacing = 8
        footer.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        footer.isLayoutMarginsRelativeArrangement = true
        footer.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 18, bottom: 18, trailing: 18)
        footer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(footer)

        status.text = "Tap the barcode to focus, then hold steady"
        status.textColor = .white
        status.font = .systemFont(ofSize: 16)
        status.textAlignment = .center
        footer.addArrangedSubview(status)

        let zoomRow = UIStackView()
        zoomRow.axis = .horizontal
        zoomRow.alignment = .center
        zoomRow.spacing = 10
        zoomLabel.text = "1.0×"
        zoomLabel.textColor = .white
        zoomLabel.widthAnchor.constraint(equalToConstant: 48).isActive = true
        zoomRow.addArrangedSubview(zoomLabel)
        zoomSlider.minimumValue = 1
        zoomSlider.maximumValue = 1
        zoomSlider.isEnabled = false
        zoomSlider.addTarget(self, action: #selector(changeZoom), for: .valueChanged)
        zoomRow.addArrangedSubview(zoomSlider)
        footer.addArrangedSubview(zoomRow)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 58),
            title.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 18),
            title.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            close.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -16),
            close.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            footer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
    }

    private func configureSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                DispatchQueue.main.async { self.fail("No rear camera is available.") }
                return
            }
            do {
                let input = try AVCaptureDeviceInput(device: camera)
                let output = AVCaptureMetadataOutput()
                self.session.beginConfiguration()
                self.session.sessionPreset = .high
                guard self.session.canAddInput(input), self.session.canAddOutput(output) else {
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.fail("The camera cannot start barcode capture.") }
                    return
                }
                self.session.addInput(input)
                self.session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                let supported = output.availableMetadataObjectTypes
                let preferred: [AVMetadataObject.ObjectType] = [
                    .ean13, .ean8, .upce, .code128, .code39, .code93, .itf14, .interleaved2of5,
                    .qr, .dataMatrix, .pdf417, .aztec
                ]
                output.metadataObjectTypes = preferred.filter { supported.contains($0) }
                output.rectOfInterest = CGRect(x: 0, y: 0, width: 1, height: 1)
                self.session.commitConfiguration()
                try camera.lockForConfiguration()
                if camera.isFocusPointOfInterestSupported {
                    camera.focusPointOfInterest = CGPoint(x: 0.5, y: 0.5)
                }
                if camera.isFocusModeSupported(.continuousAutoFocus) {
                    camera.focusMode = .continuousAutoFocus
                }
                if camera.isExposurePointOfInterestSupported {
                    camera.exposurePointOfInterest = CGPoint(x: 0.5, y: 0.5)
                }
                if camera.isExposureModeSupported(.continuousAutoExposure) {
                    camera.exposureMode = .continuousAutoExposure
                }
                camera.subjectAreaChangeMonitoringEnabled = true
                let maxZoom = min(5, camera.activeFormat.videoMaxZoomFactor)
                camera.unlockForConfiguration()
                self.device = camera
                self.metadataOutput = output
                self.isConfigured = true
                DispatchQueue.main.async {
                    self.preview.session = self.session
                    self.zoomSlider.maximumValue = Float(maxZoom)
                    self.zoomSlider.isEnabled = maxZoom > 1
                    self.zoomSlider.value = 1
                }
                self.session.startRunning()
            } catch {
                DispatchQueue.main.async { self.fail("Could not configure the camera.") }
            }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !isFinished,
              let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let value = object.stringValue, !value.isEmpty else { return }
        isFinished = true
        sessionQueue.async { [weak self] in self?.session.stopRunning() }
        onComplete?(["barcode": value, "format": object.type.rawValue, "cancelled": false])
    }

    @objc private func changeZoom() {
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = CGFloat(zoomSlider.value)
            device.unlockForConfiguration()
            zoomLabel.text = String(format: "%.1f×", zoomSlider.value)
        } catch { status.text = "Zoom is unavailable on this camera" }
    }

    @objc private func focusAtTap(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: view)
        let normalizedPoint = preview.captureDevicePointConverted(fromLayerPoint: point)
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            if device.isFocusPointOfInterestSupported {
                device.focusPointOfInterest = normalizedPoint
                if device.isFocusModeSupported(.continuousAutoFocus) {
                    device.focusMode = .continuousAutoFocus
                } else if device.isFocusModeSupported(.autoFocus) {
                    device.focusMode = .autoFocus
                }
            }
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = normalizedPoint
                if device.isExposureModeSupported(.continuousAutoExposure) {
                    device.exposureMode = .continuousAutoExposure
                }
            }
            device.unlockForConfiguration()
        } catch {
            status.text = "Camera focus is unavailable"
        }
    }

    @objc private func cancelScan() {
        guard !isFinished else { return }
        isFinished = true
        sessionQueue.async { [weak self] in self?.session.stopRunning() }
        onCancel?()
    }

    private func fail(_ message: String) {
        guard !isFinished else { return }
        isFinished = true
        onComplete?(["cancelled": true, "error": message])
    }
}
