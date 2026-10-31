package com.fueltracker.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;
import org.json.JSONObject;

/** Home-screen widget: last consumption, this month's spending, and a button that opens a new fill-up. */
public class FuelWidgetProvider extends AppWidgetProvider {
    // The web layer writes this summary with Capacitor Preferences, which stores in this SharedPreferences file.
    private static final String PREFS = "CapacitorStorage";
    private static final String KEY = "fuel-tracker-widget";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        updateAll(ctx, mgr, ids);
    }

    static void updateAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String vehicle = "bnzn", l100 = "–", month = "", add = "+ Fill-up";
        try {
            JSONObject o = new JSONObject(prefs.getString(KEY, "{}"));
            vehicle = o.optString("vehicle", vehicle);
            l100 = o.optString("l100", l100);
            month = o.optString("month", month);
            add = o.optString("add", add);
        } catch (Exception ignored) {
            // Nothing saved yet: show the defaults.
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(ctx, 0, open, flags);
        Intent addIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("fueltracker://add"), ctx, MainActivity.class);
        addIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent addPi = PendingIntent.getActivity(ctx, 1, addIntent, flags);

        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_fuel);
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
