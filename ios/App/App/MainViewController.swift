import UIKit
import Capacitor

// Our own plugin lives in the App target, not in a pod, so it is registered by hand.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FuelNativePlugin())
    }
}
