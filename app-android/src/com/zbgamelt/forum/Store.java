package com.zbgamelt.forum;

import android.content.Context;
import android.content.SharedPreferences;

/** 本地会话：登录后拿到的 sid 和昵称存这儿，App 重开还在。 */
public final class Store {
    private static final String FILE = "zbgamelt";
    private Store() {}

    private static SharedPreferences p(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static String sid(Context c) { return p(c).getString("sid", ""); }
    public static String name(Context c) { return p(c).getString("name", ""); }
    public static String role(Context c) { return p(c).getString("role", ""); }
    public static String kind(Context c) { return p(c).getString("kind", ""); }

    public static boolean logged(Context c) { return sid(c).length() > 0; }

    public static void save(Context c, String sid, String name, String role, String kind) {
        p(c).edit()
                .putString("sid", sid == null ? "" : sid)
                .putString("name", name == null ? "" : name)
                .putString("role", role == null ? "" : role)
                .putString("kind", kind == null ? "" : kind)
                .apply();
    }

    public static void clear(Context c) {
        p(c).edit().clear().apply();
    }
}
