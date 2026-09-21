package com.zbgamelt.forum;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 博客数据。
 *
 * 源是站点上的 blogfeed.json（构建时从 hugo-src 的源 Markdown 抽出来的那份），
 * 直接读它 —— 不解析 HTML：这个 App 里**没有浏览器内核**（刻意的，不是网页套壳）。
 *
 * 联网失败就退回上次缓存的副本，并把 fromCache 标出来，别让人以为看到的是最新的。
 */
public final class Blog {

    public static final String FEED = "https://zbgamelt.github.io/blogfeed.json";
    private static final String CACHE = "blogfeed.json";

    /** 读到过一次就放这儿，翻页时不用再等网络。 */
    public static Feed cached;

    public static final class Post {
        public String slug = "";
        public String title = "";
        public String dateText = "";
        public String desc = "";
        public String summary = "";
        public String md = "";
        public String url = "";
        public String tags = "";
        public int reading = 1;

        /** 「2026-09-20 · 约 2 分钟 · Hugo · 部署」 */
        public String meta() {
            StringBuilder b = new StringBuilder();
            if (dateText.length() > 0) b.append(dateText);
            if (reading > 0) {
                if (b.length() > 0) b.append(" · ");
                b.append("约 ").append(reading).append(" 分钟");
            }
            if (tags.length() > 0) {
                if (b.length() > 0) b.append(" · ");
                b.append(tags);
            }
            return b.toString();
        }
    }

    public static final class Feed {
        public String siteTitle = "ZBGAME LT";
        public String siteDesc = "";
        public String aboutTitle = "关于";
        public String aboutMd = "";
        public boolean fromCache = false;
        public final List<Post> posts = new ArrayList<Post>();
    }

    private Blog() {}

    /** 联网读一份；读不到就用缓存。两条路都没有才抛异常。 */
    public static Feed load(Context c) throws Exception {
        String json;
        boolean offline = false;
        try {
            json = http(FEED);
            write(new File(c.getFilesDir(), CACHE), json);
        } catch (Exception e) {
            File f = new File(c.getFilesDir(), CACHE);
            if (!f.exists()) throw e;
            json = read(f);
            offline = true;
        }
        Feed feed = parse(json);
        feed.fromCache = offline;
        cached = feed;
        return feed;
    }

    public static Feed parse(String json) throws Exception {
        JSONObject o = new JSONObject(json);
        Feed f = new Feed();
        JSONObject site = o.optJSONObject("site");
        if (site != null) {
            String t = Json.s(site, "title");
            if (t.length() > 0) f.siteTitle = t;
            f.siteDesc = Json.s(site, "desc");
        }
        JSONObject about = o.optJSONObject("about");
        if (about != null) {
            String t = Json.s(about, "title");
            if (t.length() > 0) f.aboutTitle = t;
            f.aboutMd = Json.s(about, "md");
        }
        JSONArray arr = o.optJSONArray("posts");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject p = arr.optJSONObject(i);
                if (p == null) continue;
                Post post = new Post();
                post.slug = Json.s(p, "slug");
                post.title = Json.s(p, "title");
                post.dateText = Json.s(p, "dateText");
                post.desc = Json.s(p, "desc");
                post.summary = Json.s(p, "summary");
                post.md = Json.s(p, "md");
                post.url = Json.s(p, "url");
                post.reading = Json.i(p, "reading");
                JSONArray tg = p.optJSONArray("tags");
                if (tg != null) {
                    StringBuilder b = new StringBuilder();
                    for (int j = 0; j < tg.length(); j++) {
                        String s = tg.optString(j, "");
                        if (s.length() == 0) continue;
                        if (b.length() > 0) b.append(" · ");
                        b.append(s);
                    }
                    post.tags = b.toString();
                }
                f.posts.add(post);
            }
        }
        return f;
    }

    public static Post find(String slug) {
        if (cached == null || slug == null) return null;
        for (Post p : cached.posts) {
            if (slug.equals(p.slug)) return p;
        }
        return null;
    }

    /** 拿站点目录里的链接反查站内文章，命中就在 App 里跳，不要跳浏览器。 */
    public static Post byUrl(String url) {
        if (cached == null || url == null) return null;
        for (Post p : cached.posts) {
            if (p.url.length() > 0 && (p.url.equals(url) || url.endsWith("/posts/" + p.slug + "/"))) return p;
        }
        return null;
    }

    static String http(String addr) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(addr).openConnection();
        con.setConnectTimeout(12000);
        con.setReadTimeout(20000);
        con.setInstanceFollowRedirects(true);
        con.setRequestProperty("User-Agent", "zbgamelt-app/1.1");
        try {
            int code = con.getResponseCode();
            if (code / 100 != 2) throw new Exception("HTTP " + code);
            InputStream in = con.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return new String(out.toByteArray(), "UTF-8");
        } finally {
            con.disconnect();
        }
    }

    private static void write(File f, String s) {
        try {
            FileOutputStream o = new FileOutputStream(f);
            o.write(s.getBytes("UTF-8"));
            o.close();
        } catch (Exception ignored) {
        }
    }

    private static String read(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return new String(out.toByteArray(), "UTF-8");
    }
}
