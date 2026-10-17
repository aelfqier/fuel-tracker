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

1. Merge the store pull request on GitHub (it includes the 16 upgrades).
2. Open **Settings › Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**,
   **Branch: main**, folder **/docs**, then **Save**.
3. After a minute these two links work. Both stores ask for them:
   - Privacy policy: https://aelfqier.github.io/fuel-tracker/privacy.html
   - Support: https://aelfqier.github.io/fuel-tracker/

## 2. Google Play

### 2.1 Account and upload key

1. Create a developer account at https://play.google.com/console/signup. Choose **Personal**,
   pay the 25 USD fee and complete the identity and phone checks. Google can take a few days.
2. Add the upload key to GitHub. Open the private file
   `fuel-tracker-store/android-upload-key/github-secrets.txt` in the project files, then go to
   **Settings › Secrets and variables › Actions › New repository secret** and add the four secrets it
   lists (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD`). Keep a copy of that folder somewhere safe and private.
3. Go to **Actions › Store builds › Run workflow** (branch `main`). When it finishes, open the run and
   download **android-google-play** under *Artifacts*. Unzip it: the `.aab` file is what Google Play
   takes.

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

### 2.4 Store listing (Grow users › Store presence › Main store listing)

Copy the texts from [listing.md](listing.md#google-play), then add the French and Arabic translations.
Upload `graphics/play-icon-512.png`, `graphics/play-feature-graphic-<language>.jpg` and the six
phone screenshots from `screenshots/googleplay/<language>/`.
**Store settings:** category **Auto & Vehicles**, a contact email (shown publicly on the store), and
the support website.

### 2.5 Closed test: 12 testers for 14 days

New personal accounts must run a closed test before Google allows a public release.

1. **Test and release › Testing › Closed testing › Create track**. Pick the countries (at least
   Morocco), and add a list of **at least 12 testers** (the Gmail addresses they use on their Android
   phones).
2. **Create release**, accept **Play App Signing** with the key Google generates (the default),
   upload the `.aab`, write a short release note, then **Review and roll out**.
3. Send the testers the opt-in link from the track's *Testers* tab. They must join and stay in for
   **14 days in a row**.

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
3. Add four GitHub secrets (Settings › Secrets and variables › Actions):

   | Secret | Value |
   | --- | --- |
   | `APPSTORE_API_KEY_ID` | the Key ID |
   | `APPSTORE_API_ISSUER_ID` | the Issuer ID |
   | `APPSTORE_API_PRIVATE_KEY` | the whole `.p8` file opened in a text editor, including the BEGIN and END lines |
   | `APPLE_TEAM_ID` | the Team ID |

4. **Actions › Store builds › Run workflow**. The iOS job signs the app and uploads it. It appears in
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
| App Review Information | Your name, phone and email. Sign-in required: **No**. Notes: `No account needed. All data stays on the device. Reminders are local notifications.` |
| Encryption | Already answered in the app (it uses no encryption of its own) |

Then on the version page choose the build under **Build**, **Save**, **Add for Review** and
**Submit to App Review**. Apple usually answers within one or two days.

## Updating the app later

1. Change `version` in `package.json` (for example `2.1.0`) and merge.
2. Run **Store builds**. The Android version code and the iOS build number come from the run number,
   so every run can be uploaded.
3. Upload the new `.aab` in the Play Console (Production › Create new release). The iOS build arrives in
   App Store Connect on its own: add it to a new version there and submit it.

## Secrets used by the workflow

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
