package com.fueltracker.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

/** Home-screen widget: last consumption, this month's spending, and a button that opens a new fill-up. */
public class FuelWidgetProvider extends AppWidgetProvider {
    // The app's own file, written by FuelNative.refreshWidget.
    private static final String PREFS = "bnzn_widget";
    private static final String KEY = "summary";
    // Older versions kept the summary in Capacitor Preferences. Read only while bnzn_widget is empty,
    // so widgets already on the home screen keep their text until the app is next opened.
    private static final String OLD_PREFS = "CapacitorStorage";
    private static final String OLD_KEY = "fuel-tracker-widget";

    @Override
    public void onEnabled(Context ctx) {
        WidgetMidnightWorker.schedule(ctx);
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        updateAll(ctx, mgr, ids);
        WidgetMidnightWorker.schedule(ctx);
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetMidnightWorker.cancel(ctx);
    }

    static void saveSummary(Context ctx, String json) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply();
    }

    // Devices without widget support (some TVs and cars) return null from getInstance.
    static int[] widgetIds(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        return mgr == null ? new int[0] : mgr.getAppWidgetIds(new ComponentName(ctx, FuelWidgetProvider.class));
    }

    static void redrawAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        if (mgr != null) updateAll(ctx, mgr, widgetIds(ctx));
    }

    private static JSONObject readSummary(Context ctx) {
        String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        if (json == null) json = ctx.getSharedPreferences(OLD_PREFS, Context.MODE_PRIVATE).getString(OLD_KEY, null);
        try {
            return new JSONObject(json != null ? json : "{}");
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static void updateAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        JSONObject o = readSummary(ctx);
        String vehicle = o.optString("vehicle", "bnzn");
        String l100 = o.optString("l100", "–");
        String add = o.optString("add", "+ Fill-up");
        // Pick the month line now rather than when it was saved, so it changes on the 1st without the app.
        // Locale.US keeps the key in ASCII digits whatever the phone's language.
        JSONObject months = o.optJSONObject("months");
        String thisMonth = new SimpleDateFormat("yyyy-MM", Locale.US).format(new Date());
        String month = months != null ? months.optString(thisMonth, "") : o.optString("month", "");

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(ctx, 0, open, flags);
        Intent addIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("fueltracker://add"), ctx, MainActivity.class);
        addIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent addPi = PendingIntent.getActivity(ctx, 1, addIntent, flags);

        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_fuel);
            // Follow the app's language rather than the phone's (the old summary has no rtl: keep the default).
            if (o.has("rtl")) {
                v.setInt(R.id.widget_root, "setLayoutDirection", o.optBoolean("rtl") ? View.LAYOUT_DIRECTION_RTL : View.LAYOUT_DIRECTION_LTR);
            }
            v.setTextViewText(R.id.widget_vehicle, vehicle);
            v.setTextViewText(R.id.widget_l100, l100);
            v.setTextViewText(R.id.widget_month, month);
            v.setTextViewText(R.id.widget_add, add);
            v.setOnClickPendingIntent(R.id.widget_root, openPi);
            v.setOnClickPendingIntent(R.id.widget_add, addPi);
            mgr.updateAppWidget(id, v);
        }
    }
}
