# Keeping bnzn healthy

A few checks a year keep the app building and accepted by both stores. Each takes under an hour.

## Every month (automatic)

- On the 1st, the **Build Android APK** workflow builds and tests the app on its own, without
  publishing anything. If it passes, there is nothing to do.
- GitHub pauses monthly runs in a repository with no activity for 60 days. If the Actions tab shows
  the workflow as disabled, open it and click **Enable workflow**.

## Every week (Dependabot pull requests)

Dependabot opens pull requests that update the npm packages and the GitHub Actions. Small updates
come grouped, one pull request for npm and one for the Actions; a new major version comes on its own.

1. Wait until both checks (**Build Android APK** and **Store builds**) are green.
2. Dependabot pull requests don't publish a test APK, so the "test" download keeps your own last
   change. If you want to try the update on your phone, merge it and install the "latest" build.
3. Green and a minor or patch update: merge it.
4. A new major version of `@capacitor/...`: close it and do it in June with the rest (below). Any
   other major version: merge it if both checks are green.
5. Red: close it. The next week's update usually fixes it; if it keeps failing, ask for help.

## February: Xcode for the App Store

Each spring (late April) Apple starts refusing uploads that weren't built with the newest Xcode and
iOS SDK. In February, check Apple's "Upcoming requirements" page and the GitHub macOS runner list.
If a newer Xcode is required, move both `runs-on: macos-26` lines in `.github/workflows/store.yml` to
the newer image, run **Store builds** from main, and check the iOS build still compiles.

## June: Capacitor and Android target

Google Play refuses updates that don't target the Android version released the year before, from
31 August each year. In June:

1. Upgrade Capacitor if a new major version is out (`npx cap migrate`, following Capacitor's upgrade
   guide), together with any `@capacitor/...` majors Dependabot proposed.
2. Raise `targetSdkVersion` and `compileSdkVersion` in `android/variables.gradle` to the new level.
   Dependabot doesn't read that file, so also check https://maven.google.com for newer versions of
   the Google libraries listed there (ML Kit text recognition, Play services base, review, WorkManager).
3. Update the version numbers in `www/licenses.txt` to match `package-lock.json` and
   `android/variables.gradle`, and add any new library with its license.
4. Install the test APK, check scanning, the widget, reminders and the report, then merge.

## Before April 2027: Node

Node 22 stops getting fixes in April 2027. Before then, change every `node-version: 22` in the two workflow
files to a newer LTS (Node 24 or later) and check the builds stay green.

## If the monthly build fails

1. Open the failed run in the Actions tab and click **Re-run jobs**. Downloads sometimes fail once.
2. If it fails again, it's usually a tool that changed (Gradle, Xcode, the runner image or an npm
   package). Nothing breaks on phones that already have the app.
3. Open an issue with the link to the run, or ask for help with it, before the next store update.

## Notes

- npm install scripts are off (`.npmrc`). To regenerate icons with `npx capacitor-assets generate`,
  first run `npm rebuild sharp --ignore-scripts=false` on your own computer.
- Store builds are signed only from a manual run on main, with the secrets in the "store" environment.
