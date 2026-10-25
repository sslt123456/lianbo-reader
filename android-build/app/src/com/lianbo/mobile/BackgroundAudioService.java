package com.lianbo.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 前台音频服务：App 退到后台时继续播放原片原声，并在通知栏同步显示当前字幕。
 * 视频画面仍由 MainActivity 的 VideoView 负责；进入后台时 MainActivity 会暂停它，
 * 防止视频和本服务同时出声。
 */
public class BackgroundAudioService extends Service {
    private static final String TAG = "LianboBgAudio";
    public static final String ACTION_START = "com.lianbo.mobile.action.BG_START";
    public static final String ACTION_TOGGLE = "com.lianbo.mobile.action.BG_TOGGLE";
    public static final String ACTION_STOP = "com.lianbo.mobile.action.BG_STOP";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_POSITION_MS = "position_ms";
    public static final String EXTRA_CUES = "cues";

    private static final String CHANNEL_ID = "lianbo_playback";
    private static final int NOTIFICATION_ID = 4207;

    private static volatile BackgroundAudioService instance;

    private MediaPlayer player;
    private AudioManager audioManager;
    private Handler handler;
    private Runnable ticker;
    private boolean prepared = false;
    private boolean paused = false;
    private boolean focusPaused = false;
    private boolean hasAudioFocus = false;
    private int startPositionMs = 0;
    private int durationMs = 0;
    private String sourceUrl = "";
    private String currentText = "";
    private String lastNotificationText = "";
    private int lastNotificationTimeBucket = -1;
    private final ArrayList<double[]> cueRanges = new ArrayList<double[]>();
    private final ArrayList<String> cueTexts = new ArrayList<String>();

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            new AudioManager.OnAudioFocusChangeListener() {
                @Override
                public void onAudioFocusChange(int focusChange) {
                    if (focusChange == AudioManager.AUDIOFOCUS_LOSS ||
                            focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                        if (player != null && player.isPlaying()) {
                            focusPaused = true;
                            paused = true;
                            try { player.pause(); } catch (Exception ignored) { }
                            updateNotification(true);
                        }
                    } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN && focusPaused) {
                        focusPaused = false;
                        if (player != null && !player.isPlaying()) {
                            paused = false;
                            try { player.start(); } catch (Exception ignored) { }
                            updateNotification(true);
                        }
                    }
                }
            };

    public static boolean isRunning() {
        return instance != null;
    }

    public static boolean isPlaying() {
        BackgroundAudioService service = instance;
        if (service == null || service.player == null) return false;
        try {
            return service.player.isPlaying() && !service.paused;
        } catch (Exception ignored) {
            return false;
        }
    }

    public static int getPositionMs() {
        BackgroundAudioService service = instance;
        if (service == null || service.player == null) return 0;
        try {
            return service.player.getCurrentPosition();
        } catch (Exception ignored) {
            return 0;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        handler = new Handler(Looper.getMainLooper());
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(action)) {
            togglePlayback();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            sourceUrl = intent.getStringExtra(EXTRA_URL);
            startPositionMs = Math.max(0, intent.getIntExtra(EXTRA_POSITION_MS, 0));
            parseCues(intent.getStringExtra(EXTRA_CUES));
            currentText = "正在准备原声…";
            startForeground(NOTIFICATION_ID, buildNotification(currentText, false));
            initPlayer();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "联播夜读后台播放", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("原片原声后台播放，并同步显示当前字幕");
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private void parseCues(String json) {
        cueRanges.clear();
        cueTexts.clear();
        if (json == null || json.length() == 0) return;
        try {
            JSONArray array = new JSONArray(json);
            for (int i = 0; i < array.length(); i++) {
                JSONArray row = array.getJSONArray(i);
                double start = row.getDouble(0);
                double end = row.getDouble(1);
                String text = row.getString(2);
                if (end <= start) continue;
                cueRanges.add(new double[]{start, end});
                cueTexts.add(text == null ? "" : text);
            }
        } catch (Exception exc) {
            Log.w(TAG, "parse cues failed", exc);
        }
    }

    private void initPlayer() {
        stopPlayerOnly();
        if (sourceUrl == null || sourceUrl.length() == 0) {
            currentText = "原片地址为空";
            updateNotification(true);
            stopSelf();
            return;
        }
        paused = false;
        prepared = false;
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                    .build());
            player.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);
            player.setDataSource(sourceUrl);
            player.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer mp) {
                    prepared = true;
                    durationMs = mp.getDuration();
                    requestAudioFocus();
                    if (startPositionMs > 0) {
                        try { mp.seekTo(startPositionMs); } catch (Exception ignored) { }
                    }
                    try { mp.start(); } catch (Exception ignored) { }
                    paused = false;
                    startTicker();
                    updateNotification(true);
                }
            });
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mp) {
                    currentText = "本段原声播放结束";
                    updateNotification(true);
                    stopSelf();
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer mp, int what, int extra) {
                    Log.e(TAG, "media error " + what + "/" + extra);
                    currentText = "后台播放失败，返回 App 可继续";
                    updateNotification(true);
                    stopSelf();
                    return true;
                }
            });
            player.prepareAsync();
        } catch (Exception exc) {
            Log.e(TAG, "init player failed", exc);
            currentText = "后台播放初始化失败";
            updateNotification(true);
            stopSelf();
        }
    }

    private void stopPlayerOnly() {
        if (ticker != null && handler != null) handler.removeCallbacks(ticker);
        ticker = null;
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { }
            try { player.release(); } catch (Exception ignored) { }
            player = null;
        }
        prepared = false;
    }

    private void startTicker() {
        if (handler == null) return;
        if (ticker != null) handler.removeCallbacks(ticker);
        ticker = new Runnable() {
            @Override
            public void run() {
                if (player != null && prepared) {
                    String text = cueTextAt(getPositionMs() / 1000.0);
                    if (text.length() == 0) text = "正在播放原声";
                    int bucket = getPositionMs() / 5000;
                    if (!text.equals(currentText) || bucket != lastNotificationTimeBucket) {
                        currentText = text;
                        lastNotificationTimeBucket = bucket;
                        updateNotification(true);
                    }
                }
                if (handler != null) handler.postDelayed(this, 600);
            }
        };
        handler.post(ticker);
    }

    private String cueTextAt(double seconds) {
        for (int i = 0; i < cueRanges.size(); i++) {
            double[] range = cueRanges.get(i);
            if (seconds >= range[0] && seconds < range[1]) {
                String text = cueTexts.get(i);
                return text == null ? "" : text;
            }
        }
        return "";
    }

    private void requestAudioFocus() {
        if (audioManager == null || hasAudioFocus) return;
        try {
            int result;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                                .build())
                        .setAcceptsDelayedFocusGain(false)
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
                result = audioManager.requestAudioFocus(request);
            } else {
                result = audioManager.requestAudioFocus(focusListener,
                        AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
            hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } catch (Exception ignored) { }
    }

    private void abandonAudioFocus() {
        if (audioManager == null || !hasAudioFocus) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
                audioManager.abandonAudioFocusRequest(request);
            } else {
                audioManager.abandonAudioFocus(focusListener);
            }
        } catch (Exception ignored) { }
        hasAudioFocus = false;
    }

    private void togglePlayback() {
        if (player == null) return;
        try {
            if (player.isPlaying()) {
                player.pause();
                paused = true;
            } else {
                player.start();
                paused = false;
            }
            updateNotification(true);
        } catch (Exception ignored) { }
    }

    private Notification buildNotification(String text, boolean includeActions) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent toggleIntent = new Intent(this, BackgroundAudioService.class).setAction(ACTION_TOGGLE);
        PendingIntent togglePending = PendingIntent.getService(this, 1, toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stopIntent = new Intent(this, BackgroundAudioService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 2, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        String display = text == null || text.length() == 0 ? "正在播放原声" : text;
        String time = "播放中";
        if (player != null && prepared) {
            int pos = getPositionMs();
            int total = durationMs > 0 ? durationMs : 0;
            time = formatTime(pos) + (total > 0 ? " / " + formatTime(total) : "");
        }
        builder.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("联播夜读 · 后台播放")
                .setContentText(display)
                .setSubText(time)
                .setContentIntent(openPending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setStyle(new Notification.BigTextStyle().bigText(display));
        if (includeActions || player != null) {
            boolean playing = false;
            try { playing = player != null && player.isPlaying(); } catch (Exception ignored) { }
            builder.addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "暂停" : "继续", togglePending);
            builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", stopPending);
        }
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_ONGOING_EVENT;
        return notification;
    }

    private void updateNotification(boolean force) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String text = currentText == null || currentText.length() == 0 ? "正在播放原声" : currentText;
        if (!force && text.equals(lastNotificationText)) return;
        lastNotificationText = text;
        try {
            manager.notify(NOTIFICATION_ID, buildNotification(text, true));
        } catch (Exception exc) {
            Log.w(TAG, "notify failed", exc);
        }
    }

    private String formatTime(int ms) {
        int total = Math.max(0, ms) / 1000;
        return String.format(Locale.CHINA, "%02d:%02d", total / 60, total % 60);
    }

    @Override
    public void onDestroy() {
        stopPlayerOnly();
        abandonAudioFocus();
        instance = null;
        try {
            stopForeground(true);
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(NOTIFICATION_ID);
        } catch (Exception ignored) { }
        super.onDestroy();
    }
}
