package com.zbgamelt.forum;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 文章正文 / 静态页。
 *
 * 正文不交给 WebView —— Markdown 由 Md 排成原生控件。
 * 文内指向站内文章的链接会在这个 App 里跳，外部链接才丢给浏览器。
 */
public class PostActivity extends Activity {

    public static final String EXTRA_SLUG = "slug";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_MD = "md";

    private LinearLayout content;
    private TextView barTitle;
    private String pageUrl = "";

    private final Md.Linker linker = new Md.Linker() {
        @Override
        public boolean open(String url) {
            Blog.Post hit = Blog.byUrl(url);
            if (hit != null) {
                Intent it = new Intent(PostActivity.this, PostActivity.class);
                it.putExtra(EXTRA_SLUG, hit.slug);
                startActivity(it);
                return true;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
            return true;
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        LinearLayout page = Ui.column(this);
        page.setBackgroundColor(Ui.BG);

        // 顶栏：返回 + 当前标题
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = Ui.dp(this, 20);
        bar.setPadding(Ui.dp(this, 12), Ui.dp(this, 14), pad, Ui.dp(this, 6));

        TextView back = Ui.tv(this, "←", 22, Ui.TEXT, false);
        back.setPadding(Ui.dp(this, 8), Ui.dp(this, 4), Ui.dp(this, 10), Ui.dp(this, 4));
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        bar.addView(back);

        barTitle = Ui.tv(this, "", 13, Ui.MUTED, false);
        barTitle.setSingleLine(true);
        barTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        bar.addView(barTitle, new LinearLayout.LayoutParams(-1, -2));
        page.addView(bar, Ui.lp(-1, -2));

        ScrollView sc = new ScrollView(this);
        sc.setBackgroundColor(Ui.BG);
        content = Ui.column(this);
        content.setPadding(pad, Ui.dp(this, 6), pad, Ui.dp(this, 48));
        sc.addView(content, Ui.lp(-1, -2));
        page.addView(sc, Ui.lp(-1, -1));
        setContentView(page);

        start();
    }

    private void start() {
        final String slug = getIntent().getStringExtra(EXTRA_SLUG);
        String md = getIntent().getStringExtra(EXTRA_MD);
        if (md != null) {
            show(getIntent().getStringExtra(EXTRA_TITLE), "", md, "");
            return;
        }
        Blog.Post p = Blog.find(slug);
        if (p != null) {
            show(p.title, p.meta(), p.md, p.url);
            return;
        }
        // 没有缓存就现拉一份
        content.addView(centre("正在取文章…", 14, Ui.MUTED));
        new Thread(new Runnable() {
            @Override
            public void run() {
                Blog.Post hit = null;
                String err = null;
                try {
                    Blog.load(PostActivity.this);
                    hit = Blog.find(slug);
                } catch (Exception e) {
                    err = e.getMessage();
                }
                final Blog.Post q = hit;
                final String why = err;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (q != null) {
                            show(q.title, q.meta(), q.md, q.url);
                        } else if (why != null) {
                            withArt("网络没接上…要不歇会儿再试");
                        } else {
                            withArt("这篇文章找不到了。");
                        }
                    }
                });
            }
        }).start();
    }

    private void show(String title, String meta, String md, String url) {
        barTitle.setText(title == null ? "" : title);
        content.removeAllViews();
        pageUrl = url == null ? "" : url;

        TextView h = Ui.tv(this, title == null ? "" : title, 22, Ui.TEXT, true);
        h.setLineSpacing(Ui.dp(this, 4), 1.12f);
        content.addView(h);

        if (meta != null && meta.length() > 0) {
            content.addView(Ui.tv(this, meta, 12.5f, Ui.MUTED, false), top(8));
        }

        LinearLayout bodyBox = Ui.column(this);
        content.addView(bodyBox, top(14));
        if (md == null || md.trim().length() == 0) {
            bodyBox.addView(Ui.para(this, "这一页还没写。", 15, Ui.MUTED));
        } else {
            Md.render(this, bodyBox, md, linker);
        }

        if (url != null && url.length() > 0) {
            View line = new View(this);
            line.setBackgroundColor(0xFF23262B);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(this, 1)));
            lp.setMargins(0, Ui.dp(this, 26), 0, Ui.dp(this, 20));
            content.addView(line, lp);

            content.addView(Ui.ghost(this, "在浏览器里打开", new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (pageUrl.length() == 0) return;
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(pageUrl)));
                    } catch (Exception ignored) {
                    }
                }
            }));
        }
    }

    private void withArt(String text) {
        content.removeAllViews();
        LinearLayout box = Ui.column(this);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.addView(new Art(this), top(24));
        TextView t = centre(text, 15, Ui.TEXT);
        box.addView(t, top(16));
        box.addView(Ui.primary(this, "返回", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        }), top(20));
        content.addView(box);
    }

    private TextView centre(String text, float sp, int color) {
        TextView t = Ui.para(this, text, sp, color);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    private LinearLayout.LayoutParams top(int dp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
        p.setMargins(0, Ui.dp(this, dp), 0, 0);
        return p;
    }
}
