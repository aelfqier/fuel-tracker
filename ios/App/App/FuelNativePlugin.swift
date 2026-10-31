import Foundation
import Capacitor
import ImageIO
import StoreKit
import UIKit
import Vision
import WebKit

extension Notification.Name {
    // Posted by the "Log a fill-up" App Intent so an app that is already open can react at once.
    static let bnznLaunchAction = Notification.Name("bnzn.launchAction")
}

// The app's own native features, reached from www/js/native.js as Capacitor.Plugins.FuelNative.
// Same methods as the Android plugin; registered by MainViewController.
@objc(FuelNativePlugin)
public class FuelNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FuelNativePlugin"
    public let jsName = "FuelNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scanStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "printHtml", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeLaunchAction", returnType: CAPPluginReturnPromise)
    ]

    static let pendingActionKey = "bnzn.pendingAction"

    // Keeps the off-screen web view alive until its PDF is written.
    private var pdfRenderer: ReportPdfRenderer?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(launchActionPosted), name: .bnznLaunchAction, object: nil)
    }

    @objc private func launchActionPosted() {
        // While the page is still loading nobody listens yet; consumeLaunchAction picks it up then.
        guard hasListeners("launchAction") else { return }
        UserDefaults.standard.removeObject(forKey: FuelNativePlugin.pendingActionKey)
        notifyListeners("launchAction", data: ["action": "add"])
    }

    @objc func scanStatus(_ call: CAPPluginCall) {
        // Vision ships with iOS, so there is nothing to download.
        call.resolve(["available": true])
    }

    @objc func recognizeText(_ call: CAPPluginCall) {
        guard var base64 = call.getString("base64"), !base64.isEmpty else {
            call.reject("No photo to read")
            return
        }
        if let comma = base64.range(of: "base64,") { base64 = String(base64[comma.upperBound...]) }
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data), let cgImage = image.cgImage else {
            call.reject("Could not open the photo")
            return
        }
        // Vision gets the photo upright, so its boxes match the reading direction.
        let orientation = FuelNativePlugin.cgOrientation(image.imageOrientation)

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            // Language correction rewrites things that are not words, like prices and litres.
            request.usesLanguageCorrection = false
            request.recognitionLanguages = ["fr-FR", "en-US"]
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
            do {
                try handler.perform([request])
            } catch {
                call.reject("Text recognition is not available", "UNAVAILABLE", error)
                return
            }
            call.resolve(["text": FuelNativePlugin.readingOrder(request.results ?? [])])
        }
    }

    @objc func refreshWidget(_ call: CAPPluginCall) {
        // No iOS widget yet (it needs an App Group).
        call.resolve()
    }

    @objc func printHtml(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), !html.isEmpty else {
            call.reject("No report to print")
            return
        }
        let fileName = FuelNativePlugin.pdfFileName(call.getString("name"))

        DispatchQueue.main.async {
            guard self.pdfRenderer == nil else {
                call.reject("A report is already being prepared")
                return
            }
            self.pdfRenderer = ReportPdfRenderer(html: html, host: self.bridge?.viewController?.view.window) { [weak self] data in
                self?.pdfRenderer = nil
                guard let self = self, let data = data else {
                    call.reject("Could not prepare the report")
                    return
                }
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName + ".pdf")
                do {
                    try data.write(to: url, options: .atomic)
                } catch {
                    call.reject("Could not save the report", nil, error)
                    return
                }
                self.share(url, call)
            }
        }
    }

    @objc func requestReview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
                ?? self.bridge?.viewController?.view.window?.windowScene
            if let scene = scene {
                SKStoreReviewController.requestReview(in: scene)
            }
            // The store never says whether the prompt showed, so this always succeeds.
            call.resolve()
        }
    }

    @objc func consumeLaunchAction(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        let action = defaults.string(forKey: FuelNativePlugin.pendingActionKey)
        defaults.removeObject(forKey: FuelNativePlugin.pendingActionKey)
        call.resolve(["action": action ?? NSNull()])
    }

    private func share(_ url: URL, _ call: CAPPluginCall) {
        guard var presenter = bridge?.viewController else {
            call.reject("Could not show the report")
            return
        }
        while let presented = presenter.presentedViewController { presenter = presented }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // On iPad the sheet is a popover and needs an anchor.
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true) {
            call.resolve()
        }
    }

    // Rebuilds the lines of a receipt or pump display: the JS parser looks for a label and its number on the same line.
    static func readingOrder(_ observations: [VNRecognizedTextObservation]) -> String {
        struct Piece {
            let text: String
            let box: CGRect
        }
        let pieces = observations.compactMap { observation -> Piece? in
            guard let text = observation.topCandidates(1).first?.string, !text.isEmpty else { return nil }
            return Piece(text: text, box: observation.boundingBox)
        }
        // Vision's origin is bottom-left, so the top of the photo has the largest y.
        var lines: [[Piece]] = []
        for piece in pieces.sorted(by: { $0.box.midY > $1.box.midY }) {
            if let line = lines.last {
                let lineMid = line.reduce(CGFloat(0)) { $0 + $1.box.midY } / CGFloat(line.count)
                let lineHeight = line.reduce(CGFloat(0)) { $0 + $1.box.height } / CGFloat(line.count)
                // Same line when the centres are closer than half the smaller text height.
                if abs(piece.box.midY - lineMid) < min(lineHeight, piece.box.height) / 2 {
                    lines[lines.count - 1].append(piece)
                    continue
                }
            }
            lines.append([piece])
        }
        return lines
            .map { line in line.sorted { $0.box.minX < $1.box.minX }.map { $0.text }.joined(separator: " ") }
            .joined(separator: "\n")
    }

    private static func cgOrientation(_ orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }

    // Keeps the name readable in Files and mail but safe as a file name.
    private static func pdfFileName(_ raw: String?) -> String {
        var name = raw ?? ""
        if name.lowercased().hasSuffix(".pdf") { name = String(name.dropLast(4)) }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let dash: Unicode.Scalar = "-"
        var safe = ""
        for scalar in name.unicodeScalars {
            safe.unicodeScalars.append(allowed.contains(scalar) ? scalar : dash)
        }
        safe = String(safe.trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(100))
        return safe.isEmpty ? "bnzn-report" : safe
    }
}

// Lays the report out in a web view nobody sees and prints it to A4 pages.
private final class ReportPdfRenderer: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var completion: ((Data?) -> Void)?

    init(html: String, host: UIView?, completion: @escaping (Data?) -> Void) {
        let paper = A4PageRenderer.paper
        webView = WKWebView(frame: paper.offsetBy(dx: -paper.width - 100, dy: 0), configuration: WKWebViewConfiguration())
        self.completion = completion
        super.init()
        webView.navigationDelegate = self
        webView.isUserInteractionEnabled = false
        webView.accessibilityElementsHidden = true
        // WebKit lays out more reliably inside a window; the frame keeps it off-screen.
        host?.addSubview(webView)
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // One more turn of the run loop lets WebKit finish laying out before printing.
        DispatchQueue.main.async {
            self.finish(self.renderPdf())
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(nil)
    }

    private func renderPdf() -> Data? {
        let renderer = A4PageRenderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        let pages = renderer.numberOfPages
        guard pages > 0 else { return nil }
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, A4PageRenderer.paper, nil)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
        for page in 0..<pages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: A4PageRenderer.paper)
        }
        UIGraphicsEndPDFContext()
        return data as Data
    }

    private func finish(_ data: Data?) {
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        let done = completion
        completion = nil
        done?(data)
    }
}

private final class A4PageRenderer: UIPrintPageRenderer {
    static let paper = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)
    // About 14 mm, the margin the report asks for with @page.
    static let margin: CGFloat = 39.7

    override var paperRect: CGRect {
        return A4PageRenderer.paper
    }

    override var printableRect: CGRect {
        return A4PageRenderer.paper.insetBy(dx: A4PageRenderer.margin, dy: A4PageRenderer.margin)
    }
}
