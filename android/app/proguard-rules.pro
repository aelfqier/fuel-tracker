# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# FuelNativePlugin needs no rule here: Capacitor's own consumer rules keep every public class that extends
# com.getcapacitor.Plugin with all its members (the bridge finds @PluginMethod methods by reflection).
# The widget provider and MainActivity are kept because the manifest names them.

# WorkManager stores the worker's class name in its database and creates it by reflection, so keep the name
# the same across updates: work queued by one version must still find its class after the next one installs.
-keep class com.fueltracker.app.WidgetMidnightWorker { <init>(...); }

# Keep line numbers so crashes from the shrunk test APK and Play Console reports stay readable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
