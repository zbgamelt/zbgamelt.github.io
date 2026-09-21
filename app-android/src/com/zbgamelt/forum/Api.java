package com.zbgamelt.forum;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;

/**
 * 论坛接口客户端。
 *
 * 就一个原则：**不加载网页**。这里只跟 Worker 的 JSON 接口说话，
 * 界面全部是原生 View —— 不是 WebView 套壳。
 *
 * 请求跑在后台线程，回调丢回主线程，调用方可以放心直接改 UI。
 */
public final class Api {
    public static final String BASE = "https://forum-api.zbgame.bid";

    public interface Cb {
        /** 成功时 err == null；失败时 ok == null、err 是可以直接显示给人看的一句话。 */
        void done(JSONObject ok, String err);
    }

    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private Api() {}

    public static void get(String path, String sid, Cb cb) {
        req("GET", path, null, sid, cb);
    }

    public static void post(String path, JSONObject body, String sid, Cb cb) {
        req("POST", path, body, sid, cb);
    }

    private static void req(final String method, final String path, final JSONObject body,
                            final String sid, final Cb cb) {
        new Thread(new Runnable() {
            @Override public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(BASE + path).openConnection();
                    conn.setConnectTimeout(12000);
                    conn.setReadTimeout(20000);
                    conn.setRequestMethod(method);
                    conn.setRequestProperty("Accept", "application/json");
                    conn.setRequestProperty("User-Agent", "zbgamelt-android/1.0");
                    if (sid != null && sid.length() > 0) {
                        conn.setRequestProperty("Authorization", "Bearer " + sid);
                    }
                    if (body != null) {
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                        OutputStream os = conn.getOutputStream();
                        os.write(body.toString().getBytes(UTF8));
                        os.flush();
                        os.close();
                    }
                    final int code = conn.getResponseCode();
                    InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    String text = readAll(in);
                    JSONObject obj = null;
                    try {
                        obj = new JSONObject(text);
                    } catch (Exception bad) {
                        /* 不是 JSON：下面按「看不懂」处理 */
                    }
                    if (obj == null) {
                        deliver(cb, null, "服务器返回看不懂（HTTP " + code + "）");
                        return;
                    }
                    String err = Json.s(obj, "error");
                    if (code >= 400 || err.length() > 0) {
                        deliver(cb, null, err.length() > 0 ? err : "出错了（HTTP " + code + "）");
                        return;
                    }
                    deliver(cb, obj, null);
                } catch (Exception e) {
                    deliver(cb, null, "网络不太好，检查一下连接");
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }, "api-" + method).start();
    }

    private static void deliver(final Cb cb, final JSONObject ok, final String err) {
        UI.post(new Runnable() {
            @Override public void run() { cb.done(ok, err); }
        });
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int k;
        while ((k = in.read(buf)) > 0) bos.write(buf, 0, k);
        try { in.close(); } catch (Exception ignore) {}
        return new String(bos.toByteArray(), UTF8);
    }

    /** 调试用：把流按行读完（保留着，偶尔排查时好用）。 */
    static String readLines(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(in, UTF8));
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        r.close();
        return sb.toString();
    }
}
