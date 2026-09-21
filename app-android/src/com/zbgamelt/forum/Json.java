package com.zbgamelt.forum;

import org.json.JSONObject;

/** JSON 取值的小包装：缺字段就给个安全的空值，别到处 NullPointerException。 */
public final class Json {
    private Json() {}

    public static String s(JSONObject o, String k) {
        if (o == null) return "";
        String v = o.optString(k, "");
        return "null".equals(v) ? "" : v;
    }

    public static int i(JSONObject o, String k) {
        return o == null ? 0 : o.optInt(k, 0);
    }

    public static long l(JSONObject o, String k) {
        return o == null ? 0L : o.optLong(k, 0L);
    }
}
