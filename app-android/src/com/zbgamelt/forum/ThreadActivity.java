package com.zbgamelt.forum;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.text.Html;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** 帖子详情：正文 + 评论 + 发评论（/api/thread、/comment）。 */
public class ThreadActivity extends Activity {
    private int number;
    private String title;

    private TextView headTitle;
    private TextView metaView;
    private TextView bodyView;
    private TextView commentsTitle;
    private LinearLayout commentsBox;
    private LinearLayout bottomBar;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        number = getIntent().getIntExtra("n", 0);
        title = getIntent().getStringExtra("t");
        if (title == null) title = "";
        setContentView(buildUi());
        load();
    }

    private View buildUi() {
        LinearLayout root = Ui.column(this);
        root.setBackgroundColor(Ui.BG);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(Ui.dp(this, 4), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 6));

        TextView back = Ui.tv(this, "‹", 28, Ui.TEXT, false);
        back.setGravity(Gravity.CENTER);
        back.setPadding(Ui.dp(this, 12), 0, Ui.dp(this, 10), Ui.dp(this, 4));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        bar.addView(back);

        TextView barTitle = Ui.tv(this, title, 15, Ui.TEXT, true);
        barTitle.setMaxLines(1);
        barTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        bar.addView(barTitle, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(bar);

        ScrollView sc = new ScrollView(this);
        sc.setBackgroundColor(Ui.BG);
        LinearLayout box = Ui.column(this);
        box.setPadding(Ui.dp(this, 16), Ui.dp(this, 6), Ui.dp(this, 16), Ui.dp(this, 26));

        headTitle = Ui.tv(this, title, 20, Ui.TEXT, true);
        headTitle.setLineSpacing(Ui.dp(this, 5), 1.05f);
        box.addView(headTitle);

        metaView = Ui.tv(this, "", 12, Ui.MUTED, false);
        metaView.setPadding(0, Ui.dp(this, 8), 0, 0);
        box.addView(metaView);

        bodyView = Ui.para(this, "", 15, 0xFFD8D9DC);
        bodyView.setPadding(0, Ui.dp(this, 14), 0, 0);
        box.addView(bodyView);

        commentsTitle = Ui.tv(this, "评论", 16, Ui.TEXT, true);
        commentsTitle.setPadding(0, Ui.dp(this, 26), 0, Ui.dp(this, 10));
        box.addView(commentsTitle);

        commentsBox = Ui.column(this);
        box.addView(commentsBox);

        sc.addView(box);
        root.addView(sc, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.HORIZONTAL);
        bottomBar.setGravity(Gravity.CENTER_VERTICAL);
        bottomBar.setBackgroundColor(Ui.BG);
        bottomBar.setPadding(Ui.dp(this, 14), Ui.dp(this, 10), Ui.dp(this, 14), Ui.dp(this, 14));
        root.addView(bottomBar);

        return root;
    }

    @Override protected void onResume() {
        super.onResume();
        renderBottomBar();
    }

    /** 底部那条：登录了就给输入框，没登录就给个登录入口。 */
    private void renderBottomBar() {
        bottomBar.removeAllViews();
        if (!Store.logged(this)) {
            TextView login = Ui.ghost(this, "登录后可以评论", new View.OnClickListener() {
                @Override public void onClick(View v) {
                    startActivity(new Intent(ThreadActivity.this, AuthActivity.class));
                }
            });
            bottomBar.addView(login, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT));
            return;
        }

        final EditText input = new EditText(this);
        input.setHint("说点什么…");
        input.setHintTextColor(Ui.MUTED);
        input.setTextColor(Ui.TEXT);
        input.setTextSize(15);
        input.setBackground(Ui.roundStroke(this, Ui.CARD, 12, Ui.LINE));
        input.setPadding(Ui.dp(this, 14), Ui.dp(this, 11), Ui.dp(this, 14), Ui.dp(this, 11));
        input.setMaxLines(4);
        bottomBar.addView(input, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        final TextView send = Ui.primary(this, "发送", null);
        LinearLayout.LayoutParams sp = Ui.lp(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        sp.leftMargin = Ui.dp(this, 10);
        bottomBar.addView(send, sp);

        send.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                final String body = input.getText().toString().trim();
                if (body.length() < 2) {
                    input.setHint("内容太短了");
                    return;
                }
                send.setEnabled(false);
                send.setAlpha(0.6f);
                JSONObject payload = new JSONObject();
                try {
                    payload.put("p", "t/" + number);
                    payload.put("body", body);
                } catch (Exception ignore) {}
                Api.post("/comment", payload, Store.sid(ThreadActivity.this), new Api.Cb() {
                    @Override public void done(JSONObject ok, String err) {
                        send.setEnabled(true);
                        send.setAlpha(1f);
                        if (err != null) {
                            input.setHint(err);
                            return;
                        }
                        input.setText("");
                        hideKeyboard();
                        load();
                    }
                });
            }
        });
    }

    private void hideKeyboard() {
        try {
            InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            View v = getCurrentFocus();
            if (im != null && v != null) im.hideSoftInputFromWindow(v.getWindowToken(), 0);
        } catch (Exception ignore) {}
    }

    private void load() {
        Api.get("/api/thread?n=" + number, Store.sid(this), new Api.Cb() {
            @Override public void done(JSONObject ok, String err) {
                if (err != null) {
                    bodyView.setText(err);
                    return;
                }
                JSONObject t = ok.optJSONObject("thread");
                if (t == null) {
                    bodyView.setText("这条帖子读不出来");
                    return;
                }
                String tt = Json.s(t, "t");
                if (tt.length() > 0) {
                    headTitle.setText(tt);
                    title = tt;
                }

                StringBuilder meta = new StringBuilder();
                String by = Json.s(t, "by");
                if (by.length() > 0) meta.append(by).append(" · ");
                String cat = Json.s(t, "cat");
                if (cat.length() > 0) meta.append(cat).append(" · ");
                String ago = Ui.ago(Json.l(t, "at"));
                if (ago.length() > 0) meta.append(ago);
                metaView.setText(meta.toString());

                String html = Json.s(t, "html");
                if (html.length() > 0) {
                    try {
                        bodyView.setText(Html.fromHtml(html));
                    } catch (Exception bad) {
                        bodyView.setText(html.replaceAll("<[^>]+>", ""));
                    }
                } else {
                    String ex = Json.s(t, "ex");
                    bodyView.setText(ex.length() > 0 ? ex : "（这篇没有正文）");
                }

                JSONArray cs = ok.optJSONArray("comments");
                int count = cs == null ? 0 : cs.length();
                commentsTitle.setText(count > 0 ? "评论（" + count + "）" : "评论");
                renderComments(cs);
            }
        });
    }

    private void renderComments(JSONArray cs) {
        commentsBox.removeAllViews();
        if (cs == null || cs.length() == 0) {
            TextView none = Ui.tv(this, "还没人说话，来当第一个。", 13, Ui.MUTED, false);
            none.setPadding(0, Ui.dp(this, 4), 0, Ui.dp(this, 4));
            commentsBox.addView(none);
            return;
        }
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.optJSONObject(i);
            if (c == null) continue;

            LinearLayout card = Ui.card(this);
            LinearLayout.LayoutParams cp = Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            cp.bottomMargin = Ui.dp(this, 10);
            card.setLayoutParams(cp);

            LinearLayout who = new LinearLayout(this);
            who.setOrientation(LinearLayout.HORIZONTAL);
            who.setGravity(Gravity.CENTER_VERTICAL);

            String name = Json.s(c, "n");
            TextView nv = Ui.tv(this, name.length() > 0 ? name : "匿名", 13, Ui.ACCENT, true);
            who.addView(nv);
            TextView tv = Ui.tv(this, Ui.ago(Json.l(c, "ts")), 11, Ui.MUTED, false);
            tv.setPadding(Ui.dp(this, 8), 0, 0, 0);
            who.addView(tv);
            card.addView(who);

            TextView body = Ui.para(this, Json.s(c, "b"), 14, 0xFFD8D9DC);
            body.setPadding(0, Ui.dp(this, 7), 0, 0);
            card.addView(body);

            commentsBox.addView(card);
        }
    }
}
