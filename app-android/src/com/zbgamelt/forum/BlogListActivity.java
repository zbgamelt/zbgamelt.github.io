package com.zbgamelt.forum;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 首页：博客文章列表。
 *
 * App 打开看到的就是这个 —— 主角是 zbgamelttwo 那个博客。论坛在下面的按钮里，
 * 同一个站的两个部分，一个 App 装下。
 */
public class BlogListActivity extends Activity {

    private LinearLayout listBox;
    private TextView sub;
    private int gen = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        LinearLayout page = Ui.column(this);
        page.setBackgroundColor(Ui.BG);

        ScrollView sc = new ScrollView(this);
        sc.setBackgroundColor(Ui.BG);

        LinearLayout body = Ui.column(this);
        int pad = Ui.dp(this, 20);
        body.setPadding(pad, Ui.dp(this, 30), pad, Ui.dp(this, 44));

        TextView brand = Ui.tv(this, "ZBGAME LT", 24, Ui.TEXT, true);
        body.addView(brand);
        sub = Ui.para(this, "轻量、干净的静态站点。", 13, Ui.MUTED);
        body.addView(sub, top(6));

        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.addView(Ui.ghost(this, "论坛", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(BlogListActivity.this, MainActivity.class));
            }
        }));
        nav.addView(Ui.ghost(this, "关于", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openAbout();
            }
        }), left(8));
        nav.addView(Ui.ghost(this, "刷新", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                load(true);
            }
        }), left(8));
        body.addView(nav, top(16));

        listBox = Ui.column(this);
        body.addView(listBox, top(20));

        sc.addView(body, Ui.lp(-1, -2));
        page.addView(sc, Ui.lp(-1, -1));
        setContentView(page);

        load(false);
    }

    private void load(final boolean force) {
        final int me = ++gen;
        listBox.removeAllViews();
        listBox.addView(centre("正在取文章…", 15, Ui.MUTED), top(30));
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final Blog.Feed f = (force || Blog.cached == null)
                            ? Blog.load(BlogListActivity.this) : Blog.cached;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (me == gen) paint(f);
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (me == gen) fail();
                        }
                    });
                }
            }
        }).start();
    }

    private void paint(Blog.Feed f) {
        listBox.removeAllViews();
        if (f.siteDesc.length() > 0) sub.setText(f.siteDesc);

        if (f.fromCache) {
            TextView n = Ui.tv(this, "离线缓存：看到的是上次存下来的内容", 12, 0xFFB99F4A, false);
            n.setBackground(Ui.round(this, 0xFF1A1A12, 999));
            n.setPadding(Ui.dp(this, 10), Ui.dp(this, 5), Ui.dp(this, 10), Ui.dp(this, 5));
            listBox.addView(n, top(0));
        }

        if (f.posts.isEmpty()) {
            listBox.addView(emptyState());
            return;
        }
        for (Blog.Post p : f.posts) {
            listBox.addView(postCard(p), bottom(12));
        }
        listBox.addView(Ui.tv(this, "共 " + f.posts.size() + " 篇 · 同步自 zbgamelt.github.io",
                12, 0xFF6E737B, false), top(8));
    }

    private View postCard(final Blog.Post p) {
        LinearLayout card = Ui.card(this);
        TextView title = Ui.tv(this, p.title, 17, Ui.TEXT, true);
        title.setLineSpacing(Ui.dp(this, 3), 1.05f);
        card.addView(title);

        if (p.meta().length() > 0) {
            card.addView(Ui.tv(this, p.meta(), 12, Ui.MUTED, false), top(6));
        }
        if (p.summary.length() > 0) {
            TextView s = Ui.para(this, p.summary, 13.5f, 0xFFA8ADB5);
            s.setMaxLines(3);
            card.addView(s, top(9));
        }
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent it = new Intent(BlogListActivity.this, PostActivity.class);
                it.putExtra(PostActivity.EXTRA_SLUG, p.slug);
                startActivity(it);
            }
        });
        return card;
    }

    private void openAbout() {
        Blog.Feed f = Blog.cached;
        Intent it = new Intent(this, PostActivity.class);
        it.putExtra(PostActivity.EXTRA_TITLE,
                f == null || f.aboutTitle.length() == 0 ? "关于" : f.aboutTitle);
        it.putExtra(PostActivity.EXTRA_MD, f == null ? "" : f.aboutMd);
        startActivity(it);
    }

    private View emptyState() {
        LinearLayout box = Ui.column(this);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.addView(new Art(this), top(24));
        TextView t = centre("还没写文章。写了就会出现在这儿。", 15, Ui.TEXT);
        box.addView(t, top(16));
        return box;
    }

    private void fail() {
        listBox.removeAllViews();
        LinearLayout box = Ui.column(this);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.addView(new Art(this), top(24));
        box.addView(centre("网络没接上…要不歇会儿再试", 15, Ui.TEXT), top(16));
        box.addView(centre("连上一次就会存在手机上，下次没网也能看。", 12.5f, Ui.MUTED), top(8));
        box.addView(Ui.primary(this, "重新加载", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                load(true);
            }
        }), top(20));
        listBox.addView(box);
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

    private LinearLayout.LayoutParams bottom(int dp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
        p.setMargins(0, 0, 0, Ui.dp(this, dp));
        return p;
    }

    private LinearLayout.LayoutParams left(int dp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-2, -2);
        p.setMargins(Ui.dp(this, dp), 0, 0, 0);
        return p;
    }
}
