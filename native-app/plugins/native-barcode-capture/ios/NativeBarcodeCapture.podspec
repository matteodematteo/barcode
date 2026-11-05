Pod::Spec.new do |s|
  s.name = 'NativeBarcodeCapture'
  s.version = '1.0.0'
  s.summary = 'Native full-frame barcode capture for Web Scanner'
  s.license = { :type => 'MIT' }
  s.author = 'Web Scanner'
  s.homepage = 'https://example.invalid/native-barcode-capture'
  s.source = { :git => 'https://example.invalid/native-barcode-capture.git', :tag => s.version.to_s }
  s.source_files = 'Sources/**/*.{swift,h,m,mm}'
  s.ios.deployment_target = '15.0'
  s.swift_version = '5.9'
  s.dependency 'Capacitor'
  s.frameworks = 'AVFoundation', 'UIKit', 'CoreMedia', 'CoreVideo'
end
