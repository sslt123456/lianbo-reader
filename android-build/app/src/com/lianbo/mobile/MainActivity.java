package com.lianbo.mobile;

import android.app.Activity;
import android.content.Intent;
import org.json.JSONArray;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;
import android.widget.MediaController;
import android.webkit.ValueCallback;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends Activity {
    private static final String TAG = "LianboMobile";
    private static final String APP_ORIGIN = "https://app.local/";

    private WebView webView;
    private TextToSpeech tts;
    private MediaPlayer onlinePlayer;
    private boolean ttsReady = false;
    private boolean ttsInitializing = false;
    private boolean ttsFailed = false;
    private String ttsError = "";
    private float speechRate = 1.0f;
    private boolean immersiveMode = false;
    private FrameLayout rootView;
    private FrameLayout nativeLayer;
    private VideoView nativeVideo;
    private TextView nativeSubtitle;
    private boolean nativeFullscreen = false;
    private boolean nativeSeeking = false;
    private int nativeSeekToken = 0;
    private int nativeMode = 0; // 0=顶部悬浮, 1=全屏, 2=平板右侧悬挂
    private boolean nativeSubtitlesOn = true;
    private boolean nativeMuted = false;
    private double nativeSyncOffsetSeconds = 0.0;
    private boolean nativeExternalCues = false;
    private boolean nativeJsSubtitleMode = false;
    private String nativeJsSubtitleText = "";
    private MediaPlayer nativeMediaPlayer;
    private Handler nativeHandler;
    private Runnable nativeTicker;
    private String nativeTranscript = "";
    private String nativeVideoUrl = "";
    private boolean backgroundPlaybackActive = false;
    private int backgroundLastPositionMs = 0;
    private ArrayList<float[]> nativeCueRanges = new ArrayList<float[]>();
    private ArrayList<String> nativeCueTexts = new ArrayList<String>();
    private int nativeVideoWidth = 0;
    private int nativeVideoHeight = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(Color.rgb(246, 243, 236));
        getWindow().setNavigationBarColor(Color.rgb(246, 243, 236));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(246, 243, 236));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " LianboMobile/1.1.1");
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return interceptAppAsset(url);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return interceptAppAsset(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternal(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternal(request.getUrl().toString());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(TAG, consoleMessage.message() + " @" + consoleMessage.lineNumber());
                return true;
            }
        });

        webView.addJavascriptInterface(new NativeBridge(), "AndroidBridge");
        webView.loadUrl(APP_ORIGIN + "index.html");
        rootView = new FrameLayout(this);
        rootView.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootView);
    }

    // ------------------------------------------------------------ local assets
    private WebResourceResponse interceptAppAsset(String url) {
        if (url == null || !url.startsWith(APP_ORIGIN)) return null;
        String path = Uri.parse(url).getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        if (path.contains("..")) return notFound();
        String assetPath = "www" + path;
        try {
            InputStream stream = getAssets().open(assetPath);
            String mime = mimeType(path);
            String encoding = isTextMime(mime) ? "UTF-8" : null;
            WebResourceResponse response = new WebResourceResponse(mime, encoding, stream);
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            response.setResponseHeaders(headers);
            return response;
        } catch (IOException exc) {
            Log.w(TAG, "asset missing: " + assetPath + " -> " + exc.getMessage());
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        byte[] body = "Not found".getBytes(Charset.forName("UTF-8"));
        WebResourceResponse response = new WebResourceResponse(
                "text/plain", "UTF-8", new ByteArrayInputStream(body));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            response.setStatusCodeAndReasonPhrase(404, "Not Found");
        }
        return response;
    }

    private static String mimeType(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".zip")) return "application/zip";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".py")) return "text/plain";
        return "application/octet-stream";
    }

    private static boolean isTextMime(String mime) {
        return mime.startsWith("text/") || "application/json".equals(mime)
                || "image/svg+xml".equals(mime);
    }

    // ------------------------------------------------------------- external url
    private boolean openExternal(String url) {
        if (url == null) return false;
        if (url.startsWith(APP_ORIGIN)) return false;
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception exc) {
            Log.w(TAG, "cannot open external url: " + url, exc);
        }
        return true;
    }

    // --------------------------------------------------------------- system ui
    private void applyImmersive(boolean on) {
        immersiveMode = on;
        View decor = getWindow().getDecorView();
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            decor.setSystemUiVisibility(flags);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.BLACK);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            decor.setSystemUiVisibility(flags);
            getWindow().setStatusBarColor(Color.rgb(246, 243, 236));
            getWindow().setNavigationBarColor(Color.rgb(246, 243, 236));
        }
    }

    // --------------------------------------------------------------- native video
    private TextView nativeButton(String label) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setTextColor(Color.WHITE);
        view.setTextSize(12);
        view.setGravity(Gravity.CENTER);
        view.setPadding(18, 10, 18, 10);
        view.setBackgroundColor(Color.argb(190, 20, 22, 26));
        return view;
    }

    private String stripSpokenPrefix(String value) {
        String text = value == null ? "" : value.trim();
        text = text.replaceFirst("^\\s*央视网消息\\s*[（(]?\\s*新闻联播\\s*[）)]?\\s*[：:]\\s*", "");
        text = text.replaceFirst("^\\s*央视网消息\\s*[：:]\\s*", "");
        text = text.replaceFirst("^\\s*[（(]\\s*新闻联播\\s*[）)]\\s*[：:]\\s*", "");
        return text.trim();
    }

    private int spokenCharCount(String text) {
        return text == null ? 0 : text.replaceAll("[\\s。！？!?；;，,、：:…—]", "").length();
    }

    private float syncPauseSeconds(String text) {
        if (text == null) return 0f;
        float total = 0f;
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch == '。' || ch == '！' || ch == '？' || ch == '!' || ch == '?') total += 1.0f;
            else if (ch == '；' || ch == ';') total += 0.72f;
            else if (ch == '：' || ch == ':') total += 0.5f;
            else if (ch == '，' || ch == ',') total += 0.34f;
            else if (ch == '、') total += 0.28f;
            else if (ch == '…') total += 0.45f;
            else if (ch == '—') total += 0.3f;
        }
        return total;
    }

    private void buildNativeCues(long durationMs) {
        if (nativeExternalCues) return;
        nativeCueRanges.clear();
        nativeCueTexts.clear();
        String text = stripSpokenPrefix(nativeTranscript == null ? "" : nativeTranscript.replaceAll("\\s+", " ").trim());
        if (text.isEmpty() || durationMs <= 0) return;
        ArrayList<String> chunks = new ArrayList<String>();
        String[] sentences = text.split("(?<=[。！？!?；;])");
        for (String sentence : sentences) {
            String item = sentence == null ? "" : sentence.trim();
            if (item.isEmpty()) continue;
            if (item.length() <= 46) { chunks.add(item); continue; }
            String current = "";
            for (String piece : item.split("(?<=[，,：:、])")) {
                if ((current + piece).length() > 42 && current.length() > 0) {
                    chunks.add(current); current = piece;
                } else current += piece;
            }
            if (current.trim().length() > 0) chunks.add(current.trim());
        }
        if (chunks.isEmpty()) return;
        ArrayList<Float> weights = new ArrayList<Float>();
        float totalWeight = 0f;
        for (String item : chunks) {
            int chars = Math.max(1, spokenCharCount(item));
            float weight = chars + syncPauseSeconds(item) * 5.0f;
            weights.add(weight);
            totalWeight += weight;
        }
        if (totalWeight <= 0f) totalWeight = 1f;
        float acc = 0f;
        for (int i = 0; i < chunks.size(); i++) {
            float start = acc / totalWeight;
            acc += weights.get(i);
            nativeCueRanges.add(new float[]{start, Math.min(1f, acc / totalWeight)});
            nativeCueTexts.add(chunks.get(i));
        }
    }

    private void updateNativeSubtitle() {
        if (nativeVideo == null || nativeSubtitle == null) return;
        if (nativeJsSubtitleMode) {
            nativeSubtitle.setText(nativeSubtitlesOn ? nativeJsSubtitleText : "");
            nativeSubtitle.post(this::positionNativeSubtitle);
            return;
        }
        if (!nativeSubtitlesOn || nativeCueRanges.isEmpty()) {
            nativeSubtitle.setText("");
            return;
        }
        int duration = nativeVideo.getDuration();
        if (duration <= 0) return;
        float fraction = (float) (nativeVideo.getCurrentPosition() / (double) duration - nativeSyncOffsetSeconds / duration);
        fraction = Math.min(0.9999f, Math.max(0f, fraction));
        String text = "";
        for (int i = 0; i < nativeCueRanges.size(); i++) {
            float[] range = nativeCueRanges.get(i);
            if (fraction >= range[0] && fraction < range[1]) { text = nativeCueTexts.get(i); break; }
        }
        nativeSubtitle.setText(text);
        nativeSubtitle.post(this::positionNativeSubtitle);
    }

    private void positionNativeSubtitle() {
        if (nativeSubtitle == null || nativeVideo == null) return;
        int cw = nativeVideo.getWidth();
        int ch = nativeVideo.getHeight();
        if (cw <= 0 || ch <= 0) return;
        float vw = nativeVideoWidth > 0 ? nativeVideoWidth : 16f;
        float vh = nativeVideoHeight > 0 ? nativeVideoHeight : 9f;
        float scale = Math.min(cw / vw, ch / vh);
        int displayW = Math.round(vw * scale);
        int displayH = Math.round(vh * scale);
        int left = (cw - displayW) / 2;
        int top = (ch - displayH) / 2;
        int bottom = top + displayH;
        nativeSubtitle.setTextSize(displayW < 900 ? 13 : 20);
        int side = Math.max(16, Math.round(displayW * 0.035f));
        int width = Math.max(1, displayW - side * 2);
        int widthSpec = View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY);
        int heightSpec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
        nativeSubtitle.measure(widthSpec, heightSpec);
        int subH = nativeSubtitle.getMeasuredHeight();
        int gap = Math.max(18, Math.round(displayH * 0.07f));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.TOP | Gravity.LEFT;
        lp.leftMargin = left + side;
        lp.topMargin = Math.max(top, bottom - subH - gap);
        nativeSubtitle.setLayoutParams(lp);
    }

    private void applyNativeLayout() {
        if (nativeLayer == null) return;
        FrameLayout.LayoutParams params;
        if (nativeMode == 1) {
            params = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        } else if (nativeMode == 2) {
            int screenW = rootView != null && rootView.getWidth() > 0
                    ? rootView.getWidth() : getResources().getDisplayMetrics().widthPixels;
            int sideW = Math.round(screenW * 0.46f);
            params = new FrameLayout.LayoutParams(sideW, Math.round(sideW * 9f / 16f));
            params.gravity = Gravity.TOP | Gravity.END;
        } else {
            int width = getResources().getDisplayMetrics().widthPixels;
            params = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(width * 9f / 16f));
            params.gravity = Gravity.TOP;
        }
        nativeLayer.setLayoutParams(params);
        if (nativeSubtitle != null) nativeSubtitle.setVisibility(View.VISIBLE);
        setRequestedOrientation(nativeFullscreen
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        applyImmersive(nativeFullscreen);
        nativeLayer.post(this::positionNativeSubtitle);
    }

    private void toggleNativeFullscreen() {
        if (nativeMode == 1) {
            nativeMode = 0;
            nativeFullscreen = false;
        } else {
            nativeMode = 1;
            nativeFullscreen = true;
            nativeSubtitlesOn = true;
        }
        applyNativeLayout();
        updateNativeSubtitle();
    }

    private void notifyJsTime() {
        if (webView == null || nativeVideo == null) return;
        final int position = nativeVideo.getCurrentPosition();
        final int duration = nativeVideo.getDuration();
        if (duration <= 0) return;
        final boolean playing = nativeVideo.isPlaying();
        final String js = "window.onNativeVideoTime && window.onNativeVideoTime("
                + (position / 1000.0) + "," + (duration / 1000.0) + ","
                + (playing ? "true" : "false") + "," + (nativeMuted ? "true" : "false") + ");";
        webView.post(new Runnable() { @Override public void run() {
            if (webView != null) webView.evaluateJavascript(js, null);
        }});
    }

    private void notifyJsEnded() {
        if (webView == null) return;
        webView.post(new Runnable() { @Override public void run() {
            if (webView != null) webView.evaluateJavascript(
                    "window.onNativeVideoEnded && window.onNativeVideoEnded();", null);
        }});
    }

    private void closeNativePlayer(boolean notifyJs) {
        if (nativeLayer == null) return;
        int position = nativeVideo == null ? 0 : nativeVideo.getCurrentPosition();
        boolean wasPlaying = nativeVideo != null && nativeVideo.isPlaying();
        if (nativeTicker != null && nativeHandler != null) nativeHandler.removeCallbacks(nativeTicker);
        nativeTicker = null;
        try { if (nativeVideo != null) { nativeVideo.stopPlayback(); } } catch (Exception ignored) { }
        try { rootView.removeView(nativeLayer); } catch (Exception ignored) { }
        nativeLayer = null; nativeVideo = null; nativeSubtitle = null; nativeMediaPlayer = null;
        nativeVideoUrl = "";
        nativeFullscreen = false; nativeMuted = false;
        nativeVideoWidth = 0; nativeVideoHeight = 0;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        applyImmersive(false);
        if (notifyJs && webView != null) {
            final String js = "window.onNativeVideoClosed && window.onNativeVideoClosed("
                    + (position / 1000.0) + "," + (wasPlaying ? "true" : "false") + ");";
            webView.post(new Runnable() { @Override public void run() {
                webView.evaluateJavascript(js, null);
            }});
        }
    }

    private void showNativePlayer(String url, String transcript, double startSeconds, boolean fullscreen) {
        showNativePlayer(url, transcript, startSeconds, fullscreen ? 1 : 0);
    }

    private void showNativePlayer(String url, String transcript, double startSeconds, int mode) {
        if (url == null || url.length() == 0) return;
        closeNativePlayer(false);
        nativeVideoUrl = url;
        nativeTranscript = transcript == null ? "" : transcript;
        nativeExternalCues = false;
        nativeJsSubtitleMode = false;
        nativeJsSubtitleText = "";
        nativeCueRanges.clear();
        nativeCueTexts.clear();
        nativeMode = mode;
        nativeFullscreen = mode == 1;
        nativeSubtitlesOn = true;
        nativeMuted = false;
        if (nativeHandler == null) nativeHandler = new Handler(Looper.getMainLooper());
        nativeLayer = new FrameLayout(this);
        nativeLayer.setBackgroundColor(Color.BLACK);
        nativeVideo = new VideoView(this);
        nativeLayer.addView(nativeVideo, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        nativeVideo.setMediaController(new MediaController(this));

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.END | Gravity.TOP);
        bar.setPadding(10, 10, 10, 10);
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.TOP;
        nativeLayer.addView(bar, barParams);

        TextView subBtn = nativeButton("字幕 开");
        TextView fsBtn = nativeButton(nativeFullscreen ? "退出全屏" : "全屏");
        TextView closeBtn = nativeButton("关闭");
        LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnParams.setMargins(8, 0, 0, 0);
        bar.addView(subBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(fsBtn, btnParams);
        bar.addView(closeBtn, btnParams);

        nativeSubtitle = new TextView(this);
        nativeSubtitle.setTextColor(Color.WHITE);
        nativeSubtitle.setTextSize(20);
        nativeSubtitle.setGravity(Gravity.CENTER);
        nativeSubtitle.setPadding(18, 10, 18, 10);
        nativeSubtitle.setBackgroundColor(Color.argb(120, 0, 0, 0));
        FrameLayout.LayoutParams subParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subParams.gravity = Gravity.TOP | Gravity.LEFT;
        nativeLayer.addView(nativeSubtitle, subParams);

        rootView.addView(nativeLayer);
        nativeLayer.setAlpha(0f);
        nativeLayer.animate().alpha(1f).setDuration(220).start();
        nativeLayer.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> positionNativeSubtitle());
        applyNativeLayout();

        subBtn.setOnClickListener(v -> {
            nativeSubtitlesOn = !nativeSubtitlesOn;
            subBtn.setText(nativeSubtitlesOn ? "字幕 开" : "字幕 关");
            updateNativeSubtitle();
        });
        fsBtn.setOnClickListener(v -> {
            toggleNativeFullscreen();
            fsBtn.setText(nativeFullscreen ? "退出全屏" : "全屏");
            subBtn.setVisibility(nativeFullscreen ? View.VISIBLE : View.GONE);
        });
        closeBtn.setOnClickListener(v -> closeNativePlayer(true));
        subBtn.setVisibility(View.VISIBLE);

        nativeVideo.setOnPreparedListener(mp -> {
            try {
                nativeMediaPlayer = mp;
                mp.setVolume(nativeMuted ? 0f : 1f, nativeMuted ? 0f : 1f);
                mp.setOnSeekCompleteListener(seeked -> { nativeSeeking = false; });
                nativeVideoWidth = mp.getVideoWidth();
                nativeVideoHeight = mp.getVideoHeight();
                if (startSeconds > 0) {
                    nativeSeeking = true;
                    int token = ++nativeSeekToken;
                    nativeVideo.seekTo((int) Math.round(startSeconds * 1000));
                    nativeHandler.postDelayed(() -> { if (token == nativeSeekToken) nativeSeeking = false; }, 2500);
                } else {
                    nativeSeeking = false;
                }
                nativeVideo.start();
                buildNativeCues(nativeVideo.getDuration());
                updateNativeSubtitle();
                nativeLayer.post(MainActivity.this::positionNativeSubtitle);
                nativeTicker = new Runnable() {
                    @Override public void run() {
                        if (!nativeSeeking) {
                            updateNativeSubtitle();
                            notifyJsTime();
                        }
                        if (nativeHandler != null && nativeLayer != null) nativeHandler.postDelayed(this, nativeSeeking ? 120 : 260);
                    }
                };
                nativeHandler.post(nativeTicker);
                callJs("window.onNativeVideoPrepared && window.onNativeVideoPrepared();");
            } catch (Exception ignored) { }
        });
        nativeVideo.setOnCompletionListener(mp -> notifyJsEnded());
        nativeVideo.setOnErrorListener((mp, what, extra) -> {
            Log.e(TAG, "native video error " + what + "/" + extra);
            Toast.makeText(MainActivity.this, "原片加载失败，可返回后打开央视页", Toast.LENGTH_SHORT).show();
            closeNativePlayer(true);
            return true;
        });
        nativeVideo.setVideoURI(Uri.parse(url));
        nativeVideo.requestFocus();
        nativeVideo.start();
    }

    // --------------------------------------------------------------- native api
    private class NativeBridge {
        @JavascriptInterface
        public void openNativeVideo(final String url, final String transcript, final double startSeconds, final boolean fullscreen) {
            runOnUiThread(new Runnable() { @Override public void run() {
                showNativePlayer(url, transcript, startSeconds, fullscreen);
            }});
        }
        @JavascriptInterface
        public void setNativeReadingLayout(final boolean side) {
            runOnUiThread(new Runnable() { @Override public void run() {
                if (nativeLayer == null || nativeMode == 1) return;
                nativeMode = side ? 2 : 0;
                nativeFullscreen = false;
                applyNativeLayout();
            }});
        }
        @JavascriptInterface
        public void openNativeVideoSide(final String url, final String transcript, final double startSeconds) {
            runOnUiThread(new Runnable() { @Override public void run() {
                showNativePlayer(url, transcript, startSeconds, 2);
            }});
        }
        @JavascriptInterface
        public void setNativeSubtitleText(final String text) {
            runOnUiThread(new Runnable() { @Override public void run() {
                nativeJsSubtitleMode = true;
                nativeJsSubtitleText = text == null ? "" : text;
                updateNativeSubtitle();
            }});
        }

        @JavascriptInterface
        public void setNativeSubtitleTimeline(final String json) {
            runOnUiThread(new Runnable() { @Override public void run() {
                try {
                    org.json.JSONArray array = new org.json.JSONArray(json);
                    ArrayList<float[]> ranges = new ArrayList<float[]>();
                    ArrayList<String> texts = new ArrayList<String>();
                    for (int i = 0; i < array.length(); i++) {
                        org.json.JSONArray row = array.getJSONArray(i);
                        ranges.add(new float[]{(float) row.getDouble(0), (float) row.getDouble(1)});
                        texts.add(row.getString(2));
                    }
                    if (!ranges.isEmpty()) {
                        nativeCueRanges = ranges;
                        nativeCueTexts = texts;
                        nativeExternalCues = true;
                        nativeJsSubtitleMode = false;
                        updateNativeSubtitle();
                    }
                } catch (Exception ignored) { }
            }});
        }

        @JavascriptInterface
        public void setSubtitleOffset(final double seconds) {
            runOnUiThread(new Runnable() { @Override public void run() {
                nativeSyncOffsetSeconds = Math.max(-2.0, Math.min(2.0, seconds));
                updateNativeSubtitle();
            }});
        }

        @JavascriptInterface
        public void setNativeMuted(final boolean muted) {
            runOnUiThread(new Runnable() { @Override public void run() {
                nativeMuted = muted;
                if (nativeMediaPlayer != null) {
                    nativeMediaPlayer.setVolume(muted ? 0f : 1f, muted ? 0f : 1f);
                }
            }});
        }
        @JavascriptInterface
        public void toggleNativeVideo() {
            runOnUiThread(new Runnable() { @Override public void run() {
                if (nativeVideo == null) return;
                if (nativeVideo.isPlaying()) nativeVideo.pause(); else nativeVideo.start();
            }});
        }
        @JavascriptInterface
        public void seekNativeVideo(final double seconds) {
            runOnUiThread(new Runnable() { @Override public void run() {
                if (nativeVideo != null) {
                    nativeSeeking = true;
                    final int token = ++nativeSeekToken;
                    nativeVideo.seekTo((int) Math.round(Math.max(0, seconds) * 1000));
                    if (nativeHandler != null) nativeHandler.postDelayed(() -> { if (token == nativeSeekToken) nativeSeeking = false; }, 2500);
                }
            }});
        }
        @JavascriptInterface
        public void closeNativeVideo() {
            runOnUiThread(new Runnable() { @Override public void run() { closeNativePlayer(true); } });
        }

        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() { applyImmersive(on); }
            });
        }

        @JavascriptInterface
        public String httpRequest(String method, String url, String headersJson, String body) {
            JSONObject result = new JSONObject();
            HttpURLConnection connection = null;
            try {
                if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
                    result.put("error", "仅支持网络请求");
                    return result.toString();
                }
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(35000);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestMethod(method == null ? "GET" : method.toUpperCase(Locale.ROOT));
                connection.setRequestProperty("Accept-Encoding", "identity");
                JSONObject headers = headersJson == null || headersJson.length() == 0
                        ? new JSONObject() : new JSONObject(headersJson);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String name = keys.next();
                    String lower = name.toLowerCase(Locale.ROOT);
                    if (lower.equals("host") || lower.equals("content-length")
                            || lower.equals("connection") || lower.equals("accept-encoding")) {
                        continue;
                    }
                    connection.setRequestProperty(name, headers.optString(name));
                }
                if (connection.getRequestProperty("User-Agent") == null) {
                    connection.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 "
                                    + "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
                }
                if (body != null && body.length() > 0
                        && !"GET".equalsIgnoreCase(connection.getRequestMethod())
                        && !"HEAD".equalsIgnoreCase(connection.getRequestMethod())) {
                    connection.setDoOutput(true);
                    byte[] payload = body.getBytes(Charset.forName("UTF-8"));
                    connection.setFixedLengthStreamingMode(payload.length);
                    OutputStream out = connection.getOutputStream();
                    out.write(payload);
                    out.close();
                }
                int status = connection.getResponseCode();
                InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                byte[] raw = readAll(input);
                String charset = "UTF-8";
                String contentType = connection.getContentType();
                if (contentType != null) {
                    int idx = contentType.toLowerCase(Locale.ROOT).indexOf("charset=");
                    if (idx >= 0) {
                        String candidate = contentType.substring(idx + 8).split(";")[0].trim();
                        try { Charset.forName(candidate); charset = candidate; } catch (Exception ignored) { }
                    }
                }
                String text = new String(raw, Charset.forName(charset));
                result.put("status", status);
                result.put("body", text);
                JSONObject responseHeaders = new JSONObject();
                for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                    String name = entry.getKey();
                    if (name == null || entry.getValue() == null) continue;
                    StringBuilder joined = new StringBuilder();
                    for (String value : entry.getValue()) {
                        if (joined.length() > 0) joined.append("\n");
                        joined.append(value);
                    }
                    responseHeaders.put(name.toLowerCase(Locale.ROOT), joined.toString());
                }
                result.put("headers", responseHeaders);
            } catch (Exception exc) {
                try { result.put("error", exc.getClass().getSimpleName() + ": " + exc.getMessage()); }
                catch (Exception ignored) { }
            } finally {
                if (connection != null) connection.disconnect();
            }
            return result.toString();
        }

        @JavascriptInterface
        public void initTts() {
            runOnUiThread(new Runnable() {
                @Override public void run() { initializeTts(); }
            });
        }

        @JavascriptInterface
        public boolean speak(final String text, final int id) {
            if (text == null || text.trim().length() == 0) return false;
            stopOnlinePlaybackInternal();
            if (ttsReady && tts != null) {
                try {
                    android.os.Bundle params = new android.os.Bundle();
                    params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
                    int status = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, String.valueOf(id));
                    if (status == TextToSpeech.SUCCESS) return true;
                } catch (Exception exc) {
                    Log.w(TAG, "system tts speak failed, trying online voice", exc);
                }
            }
            // 手机没有可用中文 TTS 时，自动回退到在线语音（百度 TTS），不依赖电脑
            speakOnline(text, id);
            return true;
        }

        @JavascriptInterface
        public void stopSpeak() {
            if (tts != null) {
                try { tts.stop(); } catch (Exception ignored) { }
            }
            stopOnlinePlaybackInternal();
        }

        @JavascriptInterface
        public void setSpeechRate(float rate) {
            speechRate = rate;
            if (tts != null) {
                try { tts.setSpeechRate(rate); } catch (Exception ignored) { }
            }
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        if (input == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) out.write(buffer, 0, read);
        input.close();
        return out.toByteArray();
    }

    // --------------------------------------------------------- online fallback
    // 手机没有中文 TTS 时使用百度在线语音，仍然不需要电脑/自建服务器。
    private void speakOnline(final String text, final int id) {
        final String safeText = text.length() > 480 ? text.substring(0, 480) : text;
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    File file = onlineTtsFile(safeText);
                    if (!file.exists() || file.length() < 1024) {
                        byte[] audio = downloadOnlineTts(safeText);
                        if (audio == null || audio.length < 1024) {
                            throw new IOException("在线语音返回为空");
                        }
                        File tmp = new File(file.getAbsolutePath() + ".tmp");
                        FileOutputStream out = new FileOutputStream(tmp);
                        out.write(audio);
                        out.close();
                        if (!tmp.renameTo(file)) {
                            tmp.delete();
                            throw new IOException("在线语音缓存失败");
                        }
                    }
                    runOnUiThread(new Runnable() {
                        @Override public void run() { playOnlineFile(file, id); }
                    });
                } catch (Exception exc) {
                    Log.w(TAG, "online tts failed", exc);
                    callJs("window.onTtsError(" + JSONObject.quote(String.valueOf(id))
                            + "," + JSONObject.quote("在线语音获取失败，请检查网络") + ")");
                }
            }
        }, "online-tts").start();
    }

    private File onlineTtsFile(String text) throws Exception {
        File dir = new File(getCacheDir(), "tts");
        if (!dir.exists()) dir.mkdirs();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(text.getBytes("UTF-8"));
        StringBuilder name = new StringBuilder();
        for (int i = 0; i < 16; i++) name.append(String.format("%02x", hash[i]));
        return new File(dir, name + ".mp3");
    }

    private byte[] downloadOnlineTts(String text) throws IOException {
        String url = "https://fanyi.baidu.com/gettts?lan=zh&text="
                + URLEncoder.encode(text, "UTF-8") + "&spd=5&source=web";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestMethod("GET");
        conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 "
                        + "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
        conn.setRequestProperty("Referer", "https://fanyi.baidu.com/");
        try {
            int status = conn.getResponseCode();
            if (status != 200) {
                Log.w(TAG, "online tts status " + status);
                return null;
            }
            return readAll(conn.getInputStream());
        } finally {
            conn.disconnect();
        }
    }

    private void playOnlineFile(final File file, final int id) {
        stopOnlinePlaybackInternal();
        try {
            final MediaPlayer player = new MediaPlayer();
            onlinePlayer = player;
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            player.setDataSource(file.getAbsolutePath());
            player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override public void onPrepared(MediaPlayer mp) {
                    if (onlinePlayer != mp) return;
                    mp.start();
                    callJs("window.onTtsStart(" + JSONObject.quote(String.valueOf(id)) + ")");
                }
            });
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(MediaPlayer mp) {
                    if (onlinePlayer == mp) onlinePlayer = null;
                    try { mp.release(); } catch (Exception ignored) { }
                    callJs("window.onTtsDone(" + JSONObject.quote(String.valueOf(id)) + ")");
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override public boolean onError(MediaPlayer mp, int what, int extra) {
                    if (onlinePlayer == mp) onlinePlayer = null;
                    try { mp.release(); } catch (Exception ignored) { }
                    callJs("window.onTtsError(" + JSONObject.quote(String.valueOf(id))
                            + "," + JSONObject.quote("在线语音播放失败") + ")");
                    return true;
                }
            });
            player.prepareAsync();
        } catch (Exception exc) {
            Log.w(TAG, "play online tts failed", exc);
            callJs("window.onTtsError(" + JSONObject.quote(String.valueOf(id))
                    + "," + JSONObject.quote("在线语音播放失败") + ")");
        }
    }

    private void stopOnlinePlaybackInternal() {
        final MediaPlayer player = onlinePlayer;
        onlinePlayer = null;
        if (player != null) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { player.stop(); } catch (Exception ignored) { }
                    try { player.release(); } catch (Exception ignored) { }
                }
            });
        }
    }

    // --------------------------------------------------------------------- tts
    private void initializeTts() {
        if (ttsReady) {
            callJs("window.onTtsReady(true," + JSONObject.quote(tts.getDefaultEngine()) + ",\"\")");
            return;
        }
        if (ttsFailed) {
            callJs("window.onTtsReady(false,\"\"," + JSONObject.quote(ttsError) + ")");
            return;
        }
        if (ttsInitializing || tts != null) return;
        ttsInitializing = true;
        tts = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                ttsInitializing = false;
                if (status != TextToSpeech.SUCCESS) {
                    ttsFailed = true;
                    ttsError = "手机没有可用的语音引擎，请在系统设置中安装中文 TTS";
                    callJs("window.onTtsReady(false,\"\"," + JSONObject.quote(ttsError) + ")");
                    return;
                }
                try {
                    // 优先标准 zh-CN，兼容只注册了 cmn/zh 的第三方语音引擎
                    Locale[] candidates = new Locale[] {
                            Locale.CHINA, Locale.SIMPLIFIED_CHINESE,
                            new Locale("zh"), new Locale("cmn")
                    };
                    int language = TextToSpeech.LANG_NOT_SUPPORTED;
                    for (Locale candidate : candidates) {
                        language = tts.setLanguage(candidate);
                        if (language == TextToSpeech.LANG_AVAILABLE
                                || language == TextToSpeech.LANG_COUNTRY_AVAILABLE
                                || language == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE) {
                            break;
                        }
                    }
                    if (language == TextToSpeech.LANG_MISSING_DATA
                            || language == TextToSpeech.LANG_NOT_SUPPORTED) {
                        ttsFailed = true;
                        ttsError = "手机缺少中文语音包，请在系统设置中安装";
                        callJs("window.onTtsReady(false,\"\"," + JSONObject.quote(ttsError) + ")");
                        return;
                    }
                    tts.setSpeechRate(speechRate);
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String utteranceId) {
                            callJs("window.onTtsStart(" + JSONObject.quote(utteranceId) + ")");
                        }
                        @Override public void onDone(String utteranceId) {
                            callJs("window.onTtsDone(" + JSONObject.quote(utteranceId) + ")");
                        }
                        @Override public void onError(String utteranceId) {
                            callJs("window.onTtsError(" + JSONObject.quote(utteranceId)
                                    + ",\"语音合成失败\")");
                        }
                        @Override public void onError(String utteranceId, int errorCode) {
                            callJs("window.onTtsError(" + JSONObject.quote(utteranceId)
                                    + ",\"语音合成失败 " + errorCode + "\")");
                        }
                    });
                    ttsReady = true;
                    callJs("window.onTtsReady(true,"
                            + JSONObject.quote(tts.getDefaultEngine()) + ",\"\")");
                } catch (Exception exc) {
                    ttsFailed = true;
                    ttsError = "TTS 启动异常: " + exc.getMessage();
                    callJs("window.onTtsReady(false,\"\"," + JSONObject.quote(ttsError) + ")");
                }
            }
        });
    }

    private void callJs(final String code) {
        if (webView == null) return;
        webView.post(new Runnable() {
            @Override public void run() {
                webView.evaluateJavascript(code, null);
            }
        });
    }

    // ------------------------------------------------------------------ lifecycle
    @Override
    public void onBackPressed() {
        if (nativeLayer != null) { closeNativePlayer(true); return; }
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){return window.handleAndroidBack ? window.handleAndroidBack() : false;})();",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if ("true".equals(value)) return;
                        if (webView != null && webView.canGoBack()) webView.goBack();
                        else MainActivity.super.onBackPressed();
                    }
                });
    }

    private String backgroundCuesJson(int durationMs) {
        JSONArray array = new JSONArray();
        if (durationMs <= 0) return array.toString();
        double offset = nativeSyncOffsetSeconds;
        for (int i = 0; i < nativeCueRanges.size(); i++) {
            float[] range = nativeCueRanges.get(i);
            try {
                JSONArray row = new JSONArray();
                row.put(Math.max(0.0, range[0] * durationMs / 1000.0 + offset));
                row.put(Math.max(0.0, range[1] * durationMs / 1000.0 + offset));
                row.put(nativeCueTexts.get(i));
                array.put(row);
            } catch (Exception ignored) { }
        }
        return array.toString();
    }

    private void startBackgroundPlayback() {
        if (nativeVideo == null || nativeVideoUrl.length() == 0 || nativeMuted) return;
        if (BackgroundAudioService.isRunning()) return;
        int position = nativeVideo.getCurrentPosition();
        int duration = nativeVideo.getDuration();
        String cues = backgroundCuesJson(duration);
        try {
            nativeVideo.pause();
        } catch (Exception ignored) { }
        backgroundPlaybackActive = true;
        backgroundLastPositionMs = position;
        Intent intent = new Intent(this, BackgroundAudioService.class);
        intent.setAction(BackgroundAudioService.ACTION_START);
        intent.putExtra(BackgroundAudioService.EXTRA_URL, nativeVideoUrl);
        intent.putExtra(BackgroundAudioService.EXTRA_POSITION_MS, position);
        intent.putExtra(BackgroundAudioService.EXTRA_CUES, cues);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                android.app.NotificationManager nm =
                        (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null && !nm.areNotificationsEnabled()) {
                    Toast.makeText(this, "通知权限未开启，后台播放时通知栏无法显示字幕", Toast.LENGTH_LONG).show();
                }
            }
        } catch (Exception ignored) { }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (Exception exc) {
            Log.e(TAG, "start background audio failed", exc);
            backgroundPlaybackActive = false;
            try { nativeVideo.start(); } catch (Exception ignored) { }
            Toast.makeText(this, "后台播放启动失败", Toast.LENGTH_SHORT).show();
        }
    }

    private void resumeFromBackgroundPlayback() {
        if (!backgroundPlaybackActive) return;
        boolean running = BackgroundAudioService.isRunning();
        boolean wasPlaying = BackgroundAudioService.isPlaying();
        int position = running ? BackgroundAudioService.getPositionMs() : backgroundLastPositionMs;
        backgroundPlaybackActive = false;
        if (running) {
            try { stopService(new Intent(this, BackgroundAudioService.class)); } catch (Exception ignored) { }
        }
        if (!running || nativeVideo == null) return;
        try {
            nativeSeeking = true;
            final int token = ++nativeSeekToken;
            nativeVideo.seekTo(Math.max(0, position));
            if (wasPlaying) nativeVideo.start();
            if (nativeHandler != null) {
                nativeHandler.postDelayed(() -> { if (token == nativeSeekToken) nativeSeeking = false; }, 2500);
            }
        } catch (Exception ignored) { }
    }

    @Override
    protected void onPause() {
        if (!isFinishing() && nativeVideo != null && nativeVideo.isPlaying()) {
            startBackgroundPlayback();
        }
        if (webView != null) webView.onPause();
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) { }
        }
        stopOnlinePlaybackInternal();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        resumeFromBackgroundPlayback();
    }

    @Override
    protected void onDestroy() {
        closeNativePlayer(false);
        applyImmersive(false);
        stopOnlinePlaybackInternal();
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (Exception ignored) { }
            tts = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
