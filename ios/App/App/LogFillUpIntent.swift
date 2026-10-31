import AppIntents
import Foundation

// "Log a fill-up" for Siri, Shortcuts, Spotlight and the Action button: opens bnzn on a new fill-up.
@available(iOS 16.0, *)
struct LogFillUpIntent: AppIntent {
    static let title: LocalizedStringResource = "Log a fill-up"
    static let description: IntentDescription? = IntentDescription("Opens bnzn on a new fill-up.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // Read by consumeLaunchAction when the page starts, or handed to it at once if the app is already open.
        UserDefaults.standard.set("add", forKey: FuelNativePlugin.pendingActionKey)
        NotificationCenter.default.post(name: .bnznLaunchAction, object: nil)
        return .result()
    }
}

// Makes the intent usable by voice and from Spotlight without the user setting up a shortcut.
@available(iOS 16.0, *)
struct BnznShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LogFillUpIntent(),
            phrases: [
                "Log a fill-up in \(.applicationName)",
                "Add fuel in \(.applicationName)",
                "Log fuel in \(.applicationName)"
            ],
            // No shortTitle: the initializer that requires it is iOS 17+; the intent's title is shown instead.
            systemImageName: "fuelpump"
        )
    }
}
