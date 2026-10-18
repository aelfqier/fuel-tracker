# Publishing bnzn on Google Play and the App Store

Everything that can be prepared without your store accounts is ready in this repository:

- The app targets Android 16 (required by Google Play for new apps since 31 August 2026) and builds
  with Xcode 26 (required by Apple since 28 April 2026).
- The **Store builds** workflow (Actions tab) makes the signed Google Play bundle and sends the iPhone
  build to App Store Connect from GitHub's Mac machines, so no Mac is needed.
- Store texts in English, French and Arabic: [listing.md](listing.md).
- Screenshots and graphics: [screenshots/](screenshots/) and [graphics/](graphics/).
- Privacy policy and support pages: [docs/](../docs/), published with GitHub Pages.
- App ID on both stores: `io.github.aelfqier.fueltracker`. It can't be changed after the first upload.

What's left needs your accounts, payments and identity, so only you can do it. The steps below are
in order. Costs: Google Play 25 USD once, Apple 99 USD per year.

---

## 1. Merge and publish the website (5 minutes)

1. Merge the store pull request on GitHub.
2. Open **Settings › Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**,
   **Branch: main**, folder **/docs**, then **Save**.
3. After a minute these two links work. Both stores ask for them:
   - Privacy policy: https://aelfqier.github.io/fuel-tracker/privacy.html
   - Support: https://aelfqier.github.io/fuel-tracker/

## 2. Google Play

### 2.1 Account and upload key

1. Create a developer account at https://play.google.com/console/signup. Choose **Personal**,
   pay the 25 USD fee and complete the identity and phone checks. Google can take a few days.
2. Add the upload key to GitHub. Create the **store** environment first if it doesn't exist yet
   (see [Secrets used by the workflow](#secrets-used-by-the-workflow)). Open the private file
   `fuel-tracker-store/android-upload-key/github-secrets.txt` in the project files, then go to
   **Settings › Environments › store › Environment secrets › Add environment secret** and add the four
   secrets it lists (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD`). Keep a copy of that folder somewhere safe and private.
3. Go to **Actions › Store builds › Run workflow** (branch `main`). The signing job waits for your
   approval: open the run, click **Review deployments**, tick **store** and **Approve and deploy**.
   When it finishes, download **android-google-play** under *Artifacts*. Unzip it: the `.aab` file
   is what Google Play takes.

### 2.2 Create the app

In the Play Console, **Create app**:

| Field | Answer |
| --- | --- |
| App name | `bnzn: Fuel Cost & L/100 km` |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free |

### 2.3 App content (Policy › App content)

| Section | Answer |
| --- | --- |
| Privacy policy | `https://aelfqier.github.io/fuel-tracker/privacy.html` |
| App access | All functionality is available without special access |
| Ads | No, my app does not contain ads |
| Content rating | Category *All other app types*; answer **No** to every question. Result: Everyone / 3+ |
| Target audience | 18 and over |
| News app | No |
| Advertising ID | No, the app doesn't use an advertising ID |
| Government app | No |
| Financial features | My app doesn't provide any financial features |
| Health | My app doesn't have any health features |
| Data safety | See below |

**Data safety.** Your own code collects nothing, but Google's ML Kit (used by the Android pump and
receipt scan) sends Google anonymous diagnostics, and Google asks apps to declare it
([ML Kit data disclosure](https://developers.google.com/ml-kit/android-data-disclosure)):

- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes**
- Account creation: **My app does not allow users to create an account**
- Data types to tick, each *Collected* (not shared), *not processed ephemerally*,
  *users can choose* (it only happens when they use Scan), purpose **Analytics**:
  - App info and performance › **Diagnostics**
  - Device or other IDs › **Device or other IDs**
- Do you provide a way for users to request that their data is deleted? **No** (the app keeps
  nothing on a server, and the ML Kit diagnostics are held by Google)

Checked again on 17 October 2026 for the switch to ML Kit through Google Play services and the
In-App Review library; the answers above still hold:

- ML Kit: Google's [disclosure page](https://developers.google.com/ml-kit/android-data-disclosure)
  lists device information, app package name and version, a device identifier (for features
  delivered through Google Play services, like ours), performance metrics, API settings, input and
  output sizes, feature version, event types and error codes, all for *diagnostics and usage
  analytics*, encrypted in transit and not transferred to third parties. Images and recognized
  text are not on the list. That is the Diagnostics and Device or other IDs entries above.
- In-App Review: per the Data safety table on Google's
  [In-App Reviews page](https://developer.android.com/guide/playcore/in-app-review#data-safety),
  the library only carries the rating and review the user types into Google Play's own window, to
  post it on the Play Store, handled by the Play Store under the Google Play Terms of Service. The
  app never receives it, so there is nothing to add.
- Report a problem and the phone's own Google backup add nothing either: the user sends the report
  themselves from their own email or messaging app, and the backup goes to the user's Google account,
  where the developer can't see it.

### 2.4 Store listing (Grow users › Store presence › Main store listing)

Copy the texts from [listing.md](listing.md#google-play), then add the French and Arabic translations.
Upload `graphics/play-icon-512.png`, `graphics/play-feature-graphic-<language>.jpg` and the six
phone screenshots from `screenshots/googleplay/<language>/`.
**Store settings:** category **Auto & Vehicles**, a contact email (shown publicly on the store), and
the support website.

**Morocco custom store listing.** Most users will be in Morocco, so give them their own listing:
**Grow users › Store presence › Custom store listings › Create custom store listing**, target
**Countries/regions: Morocco**, and copy in the texts and graphics from the main listing, with the
French and Arabic translations. It starts identical, but lets you change the Moroccan wording,
screenshots or feature graphic later without touching the listing other countries see.

### 2.5 Closed test: 12 testers for 14 days

New personal accounts must run a closed test before Google allows a public release: at least
**12 testers opted in for 14 days in a row**. If the count drops below 12, the 14 days start again.

The plan:

- **Recruit 18 to 20 testers**, so a few drop-outs don't reset the clock. Create a Google Group
  (https://groups.google.com, for example `bnzn-testers`), ask friends and family with Android phones
  to join it, and add the group's address as the tester list instead of single addresses. Testers
  must keep the app installed and stay opted in for the whole 14 days.
- **Ship two updates during the 14 days** (for example on day 5 and day 10), each fixing or improving
  something testers reported. Keep a short note of what they reported and what you changed: the
  production application asks exactly that.
- **Read the pre-launch report** after each upload (**Test and release › Testing › Pre-launch
  report**). It is free: Google installs the app on real phones, opens it, and reports crashes,
  accessibility and security warnings and screenshots.
- **Don't pay for tester farms or "12 testers" services.** Google watches for fake engagement, and
  getting caught can close the developer account.
- An **Organization** account skips the closed-test rule, but needs a registered business with a
  D-U-N-S number.

1. **Test and release › Testing › Closed testing › Create track**. Pick the countries (at least
   Morocco), and add a list of **at least 12 testers** (the Gmail addresses they use on their Android
   phones).
2. **Create release**, accept **Play App Signing** with the key Google generates (the default),
   upload the `.aab`, write a short release note, then **Review and roll out**.
3. Send the testers the opt-in link from the track's *Testers* tab. They must join and stay in for
   **14 days in a row**.

### Moving testers from the test APK to the store app

Testers who installed the test APK from GitHub have to reinstall once. The store app is signed by
Google Play with a different key, so Android won't install it over the test APK (same app ID,
different signature). Android's own backup won't carry the data across either, because it only
restores into an app with the same signature. Tell testers to:

1. In the test app: **Settings › Save backup file**, and keep the file somewhere they can reach
   (Google Drive, WhatsApp to themselves, or the phone's Downloads).
2. Uninstall the test app.
3. Install bnzn from the Play Store (the opt-in link).
4. Open it and use **Settings › Restore from file** with the saved file.

### 2.6 Production

After the 14 days, **Dashboard › Apply for production** and answer the questions about the test.
Once approved, promote the tested release to **Production** and roll it out. Google's review usually
takes from a few hours to a few days.

## 3. App Store

### 3.1 Account and app record

1. Enroll in the Apple Developer Program as an **Individual** at
   https://developer.apple.com/programs/enroll/ (99 USD per year). You need an Apple ID with two-factor
   authentication. Apple can take up to 48 hours to approve.
2. Register the app ID: https://developer.apple.com/account/resources/identifiers/list ›
   **+** › **App IDs** › **App**. Description `bnzn`, **Explicit** bundle ID
   `io.github.aelfqier.fueltracker`, no extra capabilities › **Register**.
3. In https://appstoreconnect.apple.com › **Apps › + › New App**: platform iOS, name
   `bnzn: Fuel Cost & L/100 km` (Apple names must be unique; if it's taken use one of the
   alternatives in [listing.md](listing.md#app-store)), primary language English (U.S.), the bundle ID
   from step 2, SKU `fueltracker`.

### 3.2 Let GitHub upload builds

1. In App Store Connect: **Users and Access › Integrations › App Store Connect API › Team Keys ›
   Generate API Key**. Name it `GitHub`, access **Admin** (Apple only allows cloud signing with an
   Admin key). Download the `.p8` file (Apple lets you download it once) and note the **Issuer ID**
   and the **Key ID**.
2. Find your **Team ID** at https://developer.apple.com/account › Membership details.
3. Add four secrets to the **store** environment (**Settings › Environments › store › Environment
   secrets › Add environment secret**):

   | Secret | Value |
   | --- | --- |
   | `APPSTORE_API_KEY_ID` | the Key ID |
   | `APPSTORE_API_ISSUER_ID` | the Issuer ID |
   | `APPSTORE_API_PRIVATE_KEY` | the whole `.p8` file opened in a text editor, including the BEGIN and END lines |
   | `APPLE_TEAM_ID` | the Team ID |

4. **Actions › Store builds › Run workflow**, then approve the **store** deployment in the run
   (**Review deployments**). The iOS job signs the app and uploads it. It appears in
   App Store Connect › **TestFlight** after Apple processes it (often 15 to 30 minutes). Install the
   TestFlight app on your iPhone to try it before submitting.

### 3.3 App Store page and review

| Where | Answer |
| --- | --- |
| Texts and screenshots | From [listing.md](listing.md#app-store), screenshots in the iPhone 6.9" slot from `screenshots/appstore/<language>/` |
| App Information › Category | Primary **Utilities**, secondary **Travel** |
| App Information › Age rating | Answer **No / None** to every question. Result: 4+ |
| App Privacy › Privacy policy URL | `https://aelfqier.github.io/fuel-tracker/privacy.html` |
| App Privacy › Data collection | **No, we do not collect data from this app** |
| Pricing and Availability | Free, all countries (or the ones you choose) |
| App Review Information | Your name, phone and email. Sign-in required: **No**. Notes: the text below |
| Encryption | Already answered in the app (it uses no encryption of its own) |

App Review notes (paste into *Notes*). They point the reviewer at what the iPhone app does natively,
which helps with Apple's rule against apps that are only a website in a wrapper (guideline 4.2):

```text
No account needed. All data stays on the device; there is no server.
Native iPhone features:
- Scan (Fill-up tab, Scan button at the top of the fill-up form, shown for fuel fill-ups but not for electric charging): reads the numbers on a pump display or receipt with Apple's Vision framework, on the device. Camera or photo library; the photo is not uploaded or kept.
- PDF history report (Settings > Car history report > Create PDF report): a real PDF made on the device, shared through the share sheet.
- "Log a fill-up" App Shortcut for Siri, the Shortcuts app, Spotlight and the Action button (iOS 16 or later): opens bnzn on a new fill-up.
- Local notifications: oil change, insurance, inspection and vignette reminders, and the optional "Pump price days" notification (Tools > Reminders, off by default) at 10:00 on the 1st and 16th, when Moroccan pump prices may change.
- Apple's rating prompt (SKStoreReviewController), requested after the third full-tank result, then at most once every 120 days.
- Backup file and CSV export through the share sheet and Files; iCloud device backup includes the app's data.
Settings > Report a problem prepares a text report the user reads and sends themselves; nothing is sent automatically.
To see results quickly: add two full-tank fill-ups with increasing odometer readings.
```

Then on the version page choose the build under **Build**, **Save**, **Add for Review** and
**Submit to App Review**. Apple usually answers within one or two days.

## 4. EU Digital Services Act: trader status

Both stores ask every developer whether they are a "trader" under the EU Digital Services Act, and
won't show the app in EU countries until it's answered:

- App Store Connect › **Business** › **Digital Services Act** (Apple asks before an update can go
  live in the EU).
- Play Console › **Settings › Developer account › Account details** › *Digital Services Act* trader
  declaration.

While bnzn earns no money (no ads, no paid features, no donations), answer **not a trader** in both.
If it ever earns money, you become a trader, and the stores then show your address, phone number and
email publicly on the app's page in the EU. Before switching, get a business address service
(domiciliation) and a separate phone number, so your home address and personal number never appear.

## Updating the app later

1. Change `version` in `package.json` (for example `2.1.0`) and merge.
2. Run **Store builds**. The Android version code and the iOS build number come from the run number,
   so every run can be uploaded.
3. Upload the new `.aab` in the Play Console (Production › Create new release). The iOS build arrives in
   App Store Connect on its own: add it to a new version there and submit it.

The yearly calendar (Dependabot, the new Xcode in February, Capacitor and the Android target in
June) is in [MAINTENANCE.md](../MAINTENANCE.md).

## Watching for crashes and problems

The app has no crash reporting of its own (nothing is sent automatically), so use what the stores
give for free:

- **Play Console › Monitor and improve › Android vitals**: crashes, "app not responding" and their
  rates, by phone model and Android version. Google warns there when a rate gets high enough to hurt
  the app's visibility.
- **Pre-launch report** (Test and release › Testing › Pre-launch report) after every upload.
- **App Store Connect › the app › TestFlight › Crashes** and **Feedback**: crash reports and the
  screenshots and comments testers send from the TestFlight app. For the live app, App Store Connect
  › Analytics shows the number of crashes; the full crash reports need Xcode's Organizer on a Mac.
- **Report a problem** in the app (Settings): users send you a report with the app version, phone,
  system version and the app's last error messages. It arrives the way they choose to send it.

## Secrets used by the workflow

The signing secrets live in a GitHub **environment** named `store`, not in repository secrets, so
only an approved run on `main` can use them. Set it up once:

1. **Settings › Environments › New environment**, name `store`, **Configure environment**.
2. **Deployment protection rules**: tick **Required reviewers** and add yourself. Leave **Prevent
   self-review** off (you are the only reviewer and you start the runs). **Save protection rules**.
3. **Deployment branches and tags**: choose **Selected branches and tags** and add the rule `main`.
4. Under **Environment secrets**, add the 8 secrets below.
5. If any of them already exist under **Settings › Secrets and variables › Actions › Repository
   secrets** (from an earlier setup), add them to the environment first, then delete the repository
   copies.

| Secret | Store | Where it comes from |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Google Play | `github-secrets.txt` in the project files |
| `ANDROID_KEYSTORE_PASSWORD` | Google Play | same file |
| `ANDROID_KEY_ALIAS` | Google Play | same file (`upload`) |
| `ANDROID_KEY_PASSWORD` | Google Play | same file |
| `APPSTORE_API_KEY_ID` | App Store | App Store Connect API key |
| `APPSTORE_API_ISSUER_ID` | App Store | App Store Connect API page |
| `APPSTORE_API_PRIVATE_KEY` | App Store | the downloaded `.p8` file |
| `APPLE_TEAM_ID` | App Store | Apple Developer › Membership details |

Without the Android secrets the workflow still builds, but the bundle is unsigned and Google Play refuses
it. Without the Apple secrets the iOS job only checks that the app compiles.
