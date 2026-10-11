# Fuel Tracker: Android and iOS app

The same Fuel Tracker page, packaged as a native app with Capacitor.
Fill-ups are saved on the phone itself (app storage), so the app works offline.

- App name: **Fuel Tracker**
- App ID: `com.fueltracker.app` (change it in `capacitor.config.json` before publishing, e.g. `ma.yourname.fueltracker`)
- The app's screen is `www/index.html`. After editing it, run `npx cap sync`.

## First time setup (any computer)

1. Install Node.js 22 (https://nodejs.org).
2. Unzip this folder, open a terminal in it, and run:

   ```
   npm install
   npx cap sync
   ```

## Android

**Option A: Android Studio (Windows, Mac or Linux)**

1. Install Android Studio (https://developer.android.com/studio).
2. Run `npx cap open android`. Android Studio opens the project.
3. To try it on your phone: plug the phone in with USB debugging on, then press Run.
4. To get an installable file: Build > Build App Bundle(s) / APK(s) > Build APK(s).
5. To publish on Google Play: Build > Generate Signed App Bundle, then upload the `.aab`
   in the Google Play Console (needs a Google Play developer account, one-time 25 USD fee).

**Option B: let GitHub build the APK for you (no Android Studio)**

1. Put this folder in a GitHub repository and push it to the `main` branch.
2. The workflow in `.github/workflows/android.yml` builds a test APK automatically.
3. When it finishes, open the repository's **Releases** page on your phone and download
   `fuel-tracker.apk` from the "latest" release.
4. Open the downloaded file to install it (allow "install unknown apps" when asked).

## iOS (needs a Mac)

1. Install Xcode from the Mac App Store, and CocoaPods (`sudo gem install cocoapods`).
2. Run `npx cap sync ios`, then `npx cap open ios`. Xcode opens the project.
3. Select the App target > Signing & Capabilities and choose your Apple ID team.
4. Plug in your iPhone and press Run to install it.
5. To publish on the App Store: Product > Archive, then upload through Xcode
   (needs an Apple Developer account, 99 USD per year).

## Notes

- Records live in the app's storage on the phone. Uninstalling the app deletes them.
- Icons and splash screens were generated from `assets/icon-only.png`. To change the icon,
  replace that file and run `npx capacitor-assets generate`.
