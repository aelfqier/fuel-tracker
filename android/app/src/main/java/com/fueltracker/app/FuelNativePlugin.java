package com.fueltracker.app;

import static com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate.InstallState.STATE_CANCELED;
import static com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED;
import static com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate.InstallState.STATE_FAILED;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.moduleinstall.InstallStatusListener;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallClient;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Phone features the web layer can't do on its own:
 * reading numbers from a photo (ML Kit through Google Play services, on the phone), refreshing the home-screen widget,
 * printing or saving the history report as a PDF with the system print dialog, and the Google Play review prompt.
 */
@CapacitorPlugin(name = "FuelNative")
public class FuelNativePlugin extends Plugin {
    // Long enough for the small text model on a slow connection; the scan screen waits on this.
    private static final long MODEL_TIMEOUT_MS = 60_000;
    private static final String UNAVAILABLE = "UNAVAILABLE";

    private TextRecognizer recognizer;
    private WebView printView; // kept alive until the print job has been laid out

    private boolean playServicesAvailable() {
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS;
    }

    @PluginMethod
    public void scanStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", playServicesAvailable());
        call.resolve(ret);
    }

    @PluginMethod
    public void recognizeText(PluginCall call) {
        String b64 = call.getString("base64");
        if (b64 == null || b64.isEmpty()) {
            call.reject("No image");
            return;
        }
        Bitmap bitmap;
        try {
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            call.reject("Bad image", e);
            return;
        }
        if (bitmap == null) {
            call.reject("Bad image");
            return;
        }
        if (!playServicesAvailable()) {
            call.reject("Google Play services are not available", UNAVAILABLE);
            return;
        }
        if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        // The model normally comes with the app from Google Play; fetch it now if it is still missing.
        ModuleInstallClient modules = ModuleInstall.getClient(getContext());
        modules
            .areModulesAvailable(recognizer)
            .addOnSuccessListener(r -> {
                if (r.areModulesAvailable()) recognize(call, bitmap);
                else new ModelDownload(call, bitmap, modules).start();
            })
            .addOnFailureListener(e -> call.reject("Text model not available", UNAVAILABLE, e));
    }

    private void recognize(PluginCall call, Bitmap bitmap) {
        recognizer
            .process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(result -> {
                JSObject ret = new JSObject();
                ret.put("text", result.getText());
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                if (e instanceof MlKitException && ((MlKitException) e).getErrorCode() == MlKitException.UNAVAILABLE) {
                    call.reject("Text model not available", UNAVAILABLE, e);
                } else {
                    call.reject("Recognition failed", e);
                }
            });
    }

    /** Downloads the text model, then scans once it is installed, or rejects as UNAVAILABLE on failure or timeout. */
    private class ModelDownload implements InstallStatusListener, Runnable {
        private final PluginCall call;
        private final Bitmap bitmap;
        private final ModuleInstallClient modules;
        private final Handler handler = new Handler(Looper.getMainLooper());
        private final AtomicBoolean finished = new AtomicBoolean(false);

        ModelDownload(PluginCall call, Bitmap bitmap, ModuleInstallClient modules) {
            this.call = call;
            this.bitmap = bitmap;
            this.modules = modules;
        }

        void start() {
            handler.postDelayed(this, MODEL_TIMEOUT_MS);
            ModuleInstallRequest request = ModuleInstallRequest.newBuilder().addApi(recognizer).setListener(this).build();
            modules
                .installModules(request)
                .addOnSuccessListener(r -> {
                    if (r.areModulesAlreadyInstalled()) finish(true);
                })
                .addOnFailureListener(e -> finish(false));
        }

        @Override
        public void onInstallStatusUpdated(ModuleInstallStatusUpdate update) {
            int state = update.getInstallState();
            if (state == STATE_COMPLETED) finish(true);
            else if (state == STATE_FAILED || state == STATE_CANCELED) finish(false);
        }

        @Override
        public void run() {
            finish(false); // timed out
        }

        private void finish(boolean installed) {
            if (!finished.compareAndSet(false, true)) return;
            handler.removeCallbacks(this);
            modules.unregisterListener(this);
            if (installed) recognize(call, bitmap);
            else call.reject("Text model not available", UNAVAILABLE);
        }
    }

    @PluginMethod
    public void refreshWidget(PluginCall call) {
        Context ctx = getContext();
        JSObject summary = call.getObject("summary");
        if (summary != null) FuelWidgetProvider.saveSummary(ctx, summary.toString());
        FuelWidgetProvider.redrawAll(ctx);
        // Only keep the nightly redraw going while a widget is on the home screen.
        if (FuelWidgetProvider.widgetIds(ctx).length > 0) WidgetMidnightWorker.schedule(ctx);
        call.resolve();
    }

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html", "");
        String name = call.getString("name", "bnzn");
        getActivity().runOnUiThread(() -> {
            WebView view = new WebView(getActivity());
            view.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView v, String url) {
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = v.createPrintDocumentAdapter(name);
                    pm.print(name, adapter, new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                    call.resolve();
                }
            });
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            printView = view;
        });
    }

    /** Google Play decides whether the prompt appears and tells nobody, so this always resolves. */
    @PluginMethod
    public void requestReview(PluginCall call) {
        Activity activity = getActivity();
        try {
            ReviewManager manager = ReviewManagerFactory.create(getContext());
            manager
                .requestReviewFlow()
                .addOnCompleteListener(request -> {
                    if (!request.isSuccessful() || activity == null || activity.isFinishing()) {
                        call.resolve();
                        return;
                    }
                    manager.launchReviewFlow(activity, request.getResult()).addOnCompleteListener(flow -> call.resolve());
                });
        } catch (Exception e) {
            call.resolve();
        }
    }

    /** iOS hands over the "Log a fill-up" App Intent here; Android opens fueltracker://add instead. */
    @PluginMethod
    public void consumeLaunchAction(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("action", JSONObject.NULL);
        call.resolve(ret);
    }
}
