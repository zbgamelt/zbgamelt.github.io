package com.zbgamelt.forum;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 界面零件：配色跟站点一致，控件都在代码里搭（不写 layout xml，少一层出错的地方）。 */
public final class Ui {
    public static final int BG = 0xFF0B0C0E;
    public static final int CARD = 0xFF141619;
    public static final int LINE = 0xFF23262B;
    public static final int ACCENT = 0xFFFFD83D;
    public static final int INK = 0xFF15161A;
    public static final int TEXT = 0xFFE8E8EA;
    public static final int MUTED = 0xFF8B8F96;
    public static final int DANGER = 0xFFFF6B6B;

    private Ui() {}

    public static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                c.getResources().getDisplayMetrics()));
    }

    public static GradientDrawable round(Context c, int fill, float radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(fill);
        d.setCornerRadius(dp(c, radiusDp));
        return d;
    }

    public static GradientDrawable roundStroke(Context c, int fill, float radiusDp, int strokeColor) {
        GradientDrawable d = round(c, fill, radiusDp);
        d.setStroke(Math.max(1, dp(c, 1)), strokeColor);
        return d;
    }

    public static TextView tv(Context c, String text, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(text == null ? "" : text);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    /** 带样式/可点链接的文本走这个重载。 */
    public static TextView tv(Context c, CharSequence text, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(text == null ? "" : text);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    /** 一行正文用的 TextView：行距松一点，读着舒服。 */
    public static TextView para(Context c, String text, float sp, int color) {
        TextView t = tv(c, text, sp, color, false);
        t.setLineSpacing(dp(c, 4), 1.05f);
        return t;
    }

    /** 亮色胶囊主按钮（黄底深字）。 */
    public static TextView primary(Context c, String label, View.OnClickListener l) {
        TextView t = tv(c, label, 15, INK, true);
        t.setBackground(round(c, ACCENT, 999));
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(c, 18), dp(c, 11), dp(c, 18), dp(c, 11));
        if (l != null) t.setOnClickListener(l);
        return t;
    }

    /** 深色次要按钮。 */
    public static TextView ghost(Context c, String label, View.OnClickListener l) {
        TextView t = tv(c, label, 14, TEXT, false);
        t.setBackground(roundStroke(c, CARD, 999, LINE));
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(c, 16), dp(c, 9), dp(c, 16), dp(c, 9));
        if (l != null) t.setOnClickListener(l);
        return t;
    }

    /** 一张卡片容器：圆角 + 深灰底 + 内边距。 */
    public static LinearLayout card(Context c) {
        LinearLayout box = new LinearLayout(c);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(round(c, CARD, 14));
        box.setPadding(dp(c, 14), dp(c, 13), dp(c, 14), dp(c, 13));
        return box;
    }

    public static LinearLayout column(Context c) {
        LinearLayout box = new LinearLayout(c);
        box.setOrientation(LinearLayout.VERTICAL);
        return box;
    }

    public static LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    public static LinearLayout.LayoutParams lp(int w, int h, float weight) {
        return new LinearLayout.LayoutParams(w, h, weight);
    }

    public static LinearLayout.LayoutParams margins(ViewGroup.LayoutParams src, Context c,
                                                    int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(src.width, src.height);
        p.setMargins(dp(c, l), dp(c, t), dp(c, r), dp(c, b));
        return p;
    }

    /** 毫秒时间戳 → 「3 小时前」这种。 */
    public static String ago(long ts) {
        if (ts <= 0) return "";
        long d = System.currentTimeMillis() - ts;
        if (d < 0) d = 0;
        if (d < 60L * 1000L) return "刚刚";
        long m = d / (60L * 1000L);
        if (m < 60L) return m + " 分钟前";
        long h = m / 60L;
        if (h < 24L) return h + " 小时前";
        long day = h / 24L;
        if (day < 30L) return day + " 天前";
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(ts));
    }
}
