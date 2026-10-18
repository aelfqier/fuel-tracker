package com.fueltracker.app;

import android.content.Context;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.Calendar;
import java.util.concurrent.TimeUnit;

/** Redraws the widgets just after midnight so the month line switches on the 1st without opening the app. */
public class WidgetMidnightWorker extends Worker {
    private static final String WORK = "bnzn-widget-midnight";

    public WidgetMidnightWorker(Context ctx, WorkerParameters params) {
        super(ctx, params);
    }

    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        FuelWidgetProvider.redrawAll(ctx);
        // One-time work rescheduled each night: a periodic job can't be pinned to a time of day.
        if (FuelWidgetProvider.widgetIds(ctx).length > 0) schedule(ctx);
        return Result.success();
    }

    /** Runs at 00:05 local time tomorrow, replacing any earlier request. */
    static void schedule(Context ctx) {
        Calendar next = Calendar.getInstance();
        next.add(Calendar.DAY_OF_YEAR, 1);
        next.set(Calendar.HOUR_OF_DAY, 0);
        next.set(Calendar.MINUTE, 5);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        long delay = Math.max(0, next.getTimeInMillis() - System.currentTimeMillis());
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(WidgetMidnightWorker.class)
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request);
    }

    static void cancel(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK);
    }
}
