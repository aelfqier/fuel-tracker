# bnzn: Android and iOS app

The same bnzn page, packaged as a native app with Capacitor.
Fill-ups are saved on the phone itself (app storage), so the app works offline.

- App name: **bnzn**
- App ID: `io.github.aelfqier.fueltracker` (the ID on Google Play and the App Store; it can't change after the first upload)
- The app's screen is `www/index.html`, with styles in `www/css/` and code in `www/js/`
  (`logic.js` does the calculations, `i18n.js` holds the English, French and Arabic text,
  `native.js` talks to the phone, `app.js` runs the screens). After editing, run `npx cap sync`.
- Run the calculation tests with `npm test`.
- License: all rights reserved, see [LICENSE](LICENSE). Third-party notices are in `www/licenses.txt`.

## What the app does

- Fill-ups with full or partial tank, and a "missed a fill-up" switch, so consumption is always
  measured from full tank to full tank. Edit any entry; deleting one can be undone.
- Named vehicles (cars and motorbikes; petrol, diesel, electric or plug-in hybrid in kWh), odometer
  resets and trip-meter vehicles, a warning before saving a number that looks wrong, any currency,
  French, Arabic (right to left) and English.
- A catalogue of car and motorbike models with their official fuel tank size: pick the brand and
  model when adding a vehicle and the tank size is filled in, or type it yourself.
- Optional notification on the days Moroccan pump prices may change (10:00 on the 1st and 16th, off
  until turned on), station memory with your cheapest station, trip cost with sharing between
  passengers, fill-ups abroad converted to your home currency,
  driver mode with earnings and profit per km, and reminders for oil change, insurance, technical
  inspection and vignette (with phone notifications).
- Plain-language insights, monthly budget, trend chart, backup file (Drive, WhatsApp, email),
  CSV export and a PDF history report.
- Scan the pump display or a receipt, read on the phone (Google ML Kit through Google Play services
  on Android, Apple's Vision on iPhone), an in-app store rating prompt, Report a problem and the
  open-source licenses screen.
- Android only: a home-screen widget with a "+ Fill-up" button, and a long-press app shortcut.
- iPhone only: a "Log a fill-up" shortcut for Siri, Shortcuts and the Action button.

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
   `bnzn.apk` from the "latest" release.
4. Open the downloaded file to install it (allow "install unknown apps" when asked).

Pull requests get the same APK in the "test" pre-release, so a change can be tried before merging.
Test builds share one signing key (`android/app/debug.keystore`), so a newer one installs over the
previous one and keeps your data.

## Publishing on Google Play and the App Store

No Mac needed: see [store/README.md](store/README.md) for the step-by-step guide, the store texts and the screenshots.

## iOS on your own Mac

1. Install Xcode from the Mac App Store, and CocoaPods (`sudo gem install cocoapods`).
2. Run `npx cap sync ios`, then `npx cap open ios`. Xcode opens the project.
3. Select the App target > Signing & Capabilities and choose your Apple ID team.
4. Plug in your iPhone and press Run to install it.
5. To publish on the App Store: Product > Archive, then upload through Xcode
   (needs an Apple Developer account, 99 USD per year).

## Vehicle catalogue

`www/data/vehicles.json` lists car and motorbike models with their fuel tank size in litres. The app
loads it when you add or edit a vehicle and on the first-run screen.

- Each entry has `brand`, `model`, `type` (`car` or `bike`), `variant` (engine or version, as the
  source names it), `years` (only when the source states a model year), `fuel` when the variant
  tells it, `tank`, the `source` URL and the date it was `checked`.
- Only figures from the manufacturer's own website or official documents (spec pages, price lists
  with technical data, owner's manuals, press kits) go in. If a figure can't be found there, the
  model goes under `gaps` with the reason, and is not guessed.
- `npm test` checks every entry is complete and that its source is on a manufacturer's domain
  (the list is in `tests/catalog.test.js`; add a brand's domain there when adding the brand).

## Notes

- Records live in the app's storage on the phone. Uninstalling the app deletes them (the phone's own
  backup may keep a copy), so use Settings > Backup to save a file before changing phones.
- Icons and splash screens were generated from `assets/icon-only.png`. To change the icon,
  replace that file and run `npx capacitor-assets generate` (see the note on install scripts in
  [MAINTENANCE.md](MAINTENANCE.md) first).
