package com.zbgamelt.forum;

import android.content.Context;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.method.LinkMovementMethod;
import android.text.style.BackgroundColorSpan;
import android.text.style.ClickableSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Markdown → 原生控件。
 *
 * 这个 App 里没有 WebView，正文不能丢给 HTML 渲染，所以自己排。
 * 支持：# 标题、段落、- / 1. 列表、``` 代码块、&gt; 引用、| 表格、--- 分隔线；
 * 行内支持 **粗体**、*斜体*、`代码`、[文字](链接)、![图](链接)。
 */
public final class Md {

    /** 点链接时问宿主一句：true = 你自己处理了（站内跳转），false = 交给系统。 */
    public interface Linker {
        boolean open(String url);
    }

    private static final int BODY = 0xFFC6CAD1;
    private static final int CODE_BG = 0xFF12141A;
    private static final int CODE_FG = 0xFFDCE0E6;
    private static final int LINK = 0xFFFFD83D;
    private static final int RULE = 0xFF23262B;

    private Md() {}

    public static void render(Context c, LinearLayout box, String md, Linker linker) {
        if (md == null) return;
        String[] lines = md.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        int i = 0;
        while (i < lines.length) {
            String s = lines[i].trim();
            if (s.length() == 0) {
                i++;
                continue;
            }

            // ``` 代码块
            if (s.startsWith("```")) {
                i++;
                StringBuilder b = new StringBuilder();
                while (i < lines.length && !lines[i].trim().startsWith("```")) {
                    if (b.length() > 0) b.append('\n');
                    b.append(lines[i]);
                    i++;
                }
                i++;
                box.addView(code(c, b.toString()), gap(c, 12, 12));
                continue;
            }

            // <!-- 注释 --> 整块丢掉
            if (s.startsWith("<!--")) {
                while (i < lines.length && lines[i].indexOf("-->") < 0) i++;
                i++;
                continue;
            }

            if (isRule(s)) {
                box.addView(rule(c), gap(c, 18, 18));
                i++;
                continue;
            }

            int hashes = headingLevel(s);
            if (hashes > 0) {
                String t = s.substring(hashes).trim();
                if (t.length() > 0) {
                    TextView h = Ui.tv(c, spans(c, t, linker),
                            hashes == 1 ? 21 : hashes == 2 ? 17.5f : 15.5f, 0xFFF0F1F3, true);
                    h.setLineSpacing(Ui.dp(c, 4), 1.1f);
                    linkify(h);
                    box.addView(h, gap(c, hashes <= 2 ? 20 : 14, 7));
                    i++;
                    continue;
                }
            }

            if (s.startsWith(">")) {
                StringBuilder b = new StringBuilder();
                while (i < lines.length && lines[i].trim().startsWith(">")) {
                    String q = lines[i].trim().substring(1).trim();
                    if (b.length() > 0) b.append(' ');
                    b.append(q);
                    i++;
                }
                box.addView(quote(c, spans(c, b.toString(), linker)), gap(c, 12, 12));
                continue;
            }

            if (isRow(s) && i + 1 < lines.length && isRuleRow(lines[i + 1].trim())) {
                List<String[]> rows = new ArrayList<String[]>();
                rows.add(cells(s));
                i += 2;
                while (i < lines.length && isRow(lines[i].trim())) {
                    rows.add(cells(lines[i].trim()));
                    i++;
                }
                box.addView(table(c, rows, linker), gap(c, 12, 12));
                continue;
            }

            if (bullet(s) || ordered(s)) {
                List<String> items = new ArrayList<String>();
                List<Boolean> nums = new ArrayList<Boolean>();
                while (i < lines.length) {
                    String t = lines[i].trim();
                    if (t.length() == 0) {
                        int j = i + 1;
                        while (j < lines.length && lines[j].trim().length() == 0) j++;
                        if (j < lines.length && (bullet(lines[j].trim()) || ordered(lines[j].trim()))) {
                            i = j;
                            continue;
                        }
                        break;
                    }
                    if (bullet(t)) {
                        items.add(t.substring(1).trim());
                        nums.add(Boolean.FALSE);
                        i++;
                    } else if (ordered(t)) {
                        items.add(t.substring(t.indexOf('.') + 1).trim());
                        nums.add(Boolean.TRUE);
                        i++;
                    } else {
                        break;
                    }
                }
                box.addView(list(c, items, nums, linker), gap(c, 8, 8));
                continue;
            }

            // 段落：连着几行算一段（中文硬换行，接起来更顺）
            StringBuilder b = new StringBuilder();
            while (i < lines.length) {
                String t = lines[i].trim();
                if (t.length() == 0 || headingLevel(t) > 0 || t.startsWith(">") || t.startsWith("```")
                        || isRule(t) || bullet(t) || ordered(t)) break;
                if (b.length() > 0) b.append(' ');
                b.append(t);
                i++;
            }
            if (b.length() == 0) {
                i++;        // 兜底：宁可跳一行，也绝不原地死循环
                continue;
            }
            TextView p = Ui.tv(c, spans(c, b.toString(), linker), 15.5f, BODY, false);
            p.setLineSpacing(Ui.dp(c, 7), 1.08f);
            linkify(p);
            box.addView(p, gap(c, 5, 5));
        }
    }

    // ── 各种块零件 ──────────────────────────────

    private static TextView code(Context c, String text) {
        TextView t = Ui.tv(c, text, 12.5f, CODE_FG, false);
        t.setTypeface(Typeface.MONOSPACE);
        t.setBackground(Ui.round(c, CODE_BG, 10));
        int p = Ui.dp(c, 12);
        t.setPadding(p, p, p, p);
        t.setLineSpacing(Ui.dp(c, 3), 1.0f);
        t.setTextIsSelectable(true);
        return t;
    }

    private static View quote(Context c, CharSequence text) {
        LinearLayout row = new LinearLayout(c);
        row.setOrientation(LinearLayout.HORIZONTAL);
        View bar = new View(c);
        bar.setBackgroundColor(0xFF3A3F47);
        row.addView(bar, new LinearLayout.LayoutParams(Ui.dp(c, 3), -1));
        TextView t = Ui.tv(c, text, 14.5f, 0xFFA9AEB6, false);
        t.setLineSpacing(Ui.dp(c, 5), 1.06f);
        linkify(t);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-1, -2);
        tp.setMargins(Ui.dp(c, 12), 0, 0, 0);
        row.addView(t, tp);
        return row;
    }

    private static View list(Context c, List<String> items, List<Boolean> nums, Linker linker) {
        LinearLayout box = Ui.column(c);
        for (int k = 0; k < items.size(); k++) {
            LinearLayout row = new LinearLayout(c);
            row.setOrientation(LinearLayout.HORIZONTAL);
            String mark = nums.get(k) ? (k + 1) + "." : "•";
            TextView dot = Ui.tv(c, mark, 15, 0xFF8B8F96, false);
            row.addView(dot, new LinearLayout.LayoutParams(Ui.dp(c, 22), -2));
            TextView t = Ui.tv(c, spans(c, items.get(k), linker), 15.5f, BODY, false);
            t.setLineSpacing(Ui.dp(c, 6), 1.06f);
            linkify(t);
            row.addView(t, new LinearLayout.LayoutParams(-1, -2));
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(-1, -2);
            rp.setMargins(0, 0, 0, Ui.dp(c, 6));
            box.addView(row, rp);
        }
        return box;
    }

    private static View table(Context c, List<String[]> rows, Linker linker) {
        LinearLayout box = Ui.column(c);
        box.setBackground(Ui.roundStroke(c, 0xFF101215, 10, RULE));
        int p = Ui.dp(c, 10);
        box.setPadding(p, p, p, p);
        for (int r = 0; r < rows.size(); r++) {
            if (r > 0) {
                View line = new View(c);
                line.setBackgroundColor(RULE);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(c, 1)));
                lp.setMargins(0, Ui.dp(c, 8), 0, Ui.dp(c, 8));
                box.addView(line, lp);
            }
            String[] cells = rows.get(r);
            LinearLayout row = new LinearLayout(c);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int k = 0; k < cells.length; k++) {
                TextView t = Ui.tv(c, spans(c, cells[k], linker), 13,
                        r == 0 ? 0xFFF0F1F3 : BODY, r == 0);
                t.setLineSpacing(Ui.dp(c, 3), 1.04f);
                linkify(t);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1f);
                if (k > 0) lp.setMargins(Ui.dp(c, 10), 0, 0, 0);
                row.addView(t, lp);
            }
            box.addView(row, new LinearLayout.LayoutParams(-1, -2));
        }
        return box;
    }

    private static View rule(Context c) {
        View v = new View(c);
        v.setBackgroundColor(RULE);
        return v;
    }

    private static LinearLayout.LayoutParams gap(Context c, int top, int bottom) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
        p.setMargins(0, Ui.dp(c, top), 0, Ui.dp(c, bottom));
        return p;
    }

    // ── 行内样式 ────────────────────────────────

    static CharSequence spans(final Context c, String s, final Linker linker) {
        SpannableStringBuilder out = new SpannableStringBuilder();
        int n = s.length();
        int i = 0;
        while (i < n) {
            char ch = s.charAt(i);

            // 裸 HTML 标签直接丢掉（不渲染 HTML，只把它从文字里摘掉）
            if (ch == '<') {
                int e = s.indexOf('>', i);
                if (e > i && e - i <= 90) {
                    i = e + 1;
                    continue;
                }
            }
            if (ch == '`') {
                int e = s.indexOf('`', i + 1);
                if (e > i) {
                    int st = out.length();
                    out.append(s, i + 1, e);
                    out.setSpan(new TypefaceSpan("monospace"), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new ForegroundColorSpan(0xFFE6C86A), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new BackgroundColorSpan(0xFF1B1E23), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = e + 1;
                    continue;
                }
            }
            if (ch == '*' && i + 1 < n && s.charAt(i + 1) == '*') {
                int e = s.indexOf("**", i + 2);
                if (e > i) {
                    int st = out.length();
                    out.append(spans(c, s.substring(i + 2, e), linker));
                    out.setSpan(new StyleSpan(Typeface.BOLD), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = e + 2;
                    continue;
                }
            }
            if (ch == '*') {
                int e = s.indexOf('*', i + 1);
                if (e > i) {
                    int st = out.length();
                    out.append(spans(c, s.substring(i + 1, e), linker));
                    out.setSpan(new StyleSpan(Typeface.ITALIC), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = e + 1;
                    continue;
                }
            }
            if (ch == '!' && i + 1 < n && s.charAt(i + 1) == '[') {
                String hit = link(s, i + 1);
                if (hit != null) {
                    int rb = s.indexOf(']', i + 2);
                    int rp = s.indexOf(')', rb + 2);
                    String alt = s.substring(i + 2, rb);
                    int st = out.length();
                    out.append(alt.length() > 0 ? alt : "图片");
                    out.setSpan(new ForegroundColorSpan(0xFF8B8F96), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(click(hit, linker), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = rp + 1;
                    continue;
                }
            }
            if (ch == '[') {
                String hit = link(s, i);
                if (hit != null) {
                    int rb = s.indexOf(']', i + 1);
                    int rp = s.indexOf(')', rb + 2);
                    int st = out.length();
                    out.append(spans(c, s.substring(i + 1, rb), linker));
                    out.setSpan(new ForegroundColorSpan(LINK), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(click(hit, linker), st, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = rp + 1;
                    continue;
                }
            }
            out.append(ch);
            i++;
        }
        return out;
    }

    /** 命中 [文字](链接) 就返回链接，否则 null。at 是 '[' 的位置。 */
    private static String link(String s, int at) {
        if (at < 0 || at >= s.length() || s.charAt(at) != '[') return null;
        int rb = s.indexOf(']', at + 1);
        if (rb <= at || rb + 1 >= s.length() || s.charAt(rb + 1) != '(') return null;
        int rp = s.indexOf(')', rb + 2);
        if (rp <= rb) return null;
        return s.substring(rb + 2, rp).trim();
    }

    private static ClickableSpan click(final String url, final Linker linker) {
        return new ClickableSpan() {
            @Override
            public void onClick(View w) {
                if (linker != null) linker.open(url);
            }

            @Override
            public void updateDrawState(TextPaint ds) {
                ds.setColor(LINK);
                ds.setUnderlineText(false);
            }
        };
    }

    private static void linkify(TextView t) {
        t.setMovementMethod(LinkMovementMethod.getInstance());
        t.setHighlightColor(0x00000000);
    }

    // ── 判定小工具 ──────────────────────────────

    private static int headingLevel(String s) {
        int n = 0;
        while (n < s.length() && s.charAt(n) == '#') n++;
        if (n == 0 || n > 6) return 0;
        if (n >= s.length() || s.charAt(n) != ' ') return 0;
        return n;
    }

    private static boolean bullet(String t) {
        return t.length() > 2 && (t.startsWith("- ") || t.startsWith("* ") || t.startsWith("+ "));
    }

    private static boolean ordered(String t) {
        int i = 0;
        while (i < t.length() && Character.isDigit(t.charAt(i))) i++;
        return i > 0 && i + 1 < t.length() && t.charAt(i) == '.' && t.charAt(i + 1) == ' ';
    }

    private static boolean isRule(String s) {
        if (s.length() < 3) return false;
        char c = s.charAt(0);
        if (c != '-' && c != '*' && c != '_') return false;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) != c) return false;
        return true;
    }

    private static boolean isRow(String s) {
        return s.length() > 2 && s.charAt(0) == '|' && s.charAt(s.length() - 1) == '|';
    }

    private static boolean isRuleRow(String s) {
        if (!isRow(s)) return false;
        for (int i = 1; i < s.length() - 1; i++) {
            char ch = s.charAt(i);
            if (ch != '-' && ch != ':' && ch != '|' && ch != ' ') return false;
        }
        return true;
    }

    private static String[] cells(String s) {
        String body = s.substring(1, s.length() - 1);
        String[] raw = body.split("\\|");
        for (int i = 0; i < raw.length; i++) raw[i] = raw[i].trim();
        return raw;
    }
}
