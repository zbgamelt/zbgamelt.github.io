package com.zbgamelt.forum;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/** 我的：当前账号 + 退出登录（头像之类先不折腾，重点是能用）。 */
public class MeActivity extends Activity {
    private TextView nameView;
    private TextView roleView;
    private TextView footView;
    private TextView loginBtn;
    private TextView outBtn;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(buildUi());
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
    }

    private View buildUi() {
        LinearLayout root = Ui.column(this);
        root.setBackgroundColor(Ui.BG);
        root.setPadding(Ui.dp(this, 20), Ui.dp(this, 24), Ui.dp(this, 20), Ui.dp(this, 24));

        TextView back = Ui.tv(this, "‹ 返回", 14, Ui.MUTED, false);
        back.setPadding(0, 0, 0, Ui.dp(this, 20));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        root.addView(back);

        LinearLayout card = Ui.card(this);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(Ui.dp(this, 16), Ui.dp(this, 24), Ui.dp(this, 16), Ui.dp(this, 24));

        TextView badge = Ui.tv(this, "ZBGAME", 12, Ui.INK, true);
        badge.setBackground(Ui.round(this, Ui.ACCENT, 999));
        badge.setPadding(Ui.dp(this, 12), Ui.dp(this, 5), Ui.dp(this, 12), Ui.dp(this, 5));
        card.addView(badge);

        nameView = Ui.tv(this, "", 20, Ui.TEXT, true);
        nameView.setPadding(0, Ui.dp(this, 14), 0, 0);
        card.addView(nameView);

        roleView = Ui.tv(this, "", 13, Ui.MUTED, false);
        roleView.setPadding(0, Ui.dp(this, 6), 0, 0);
        card.addView(roleView);

        footView = Ui.tv(this, "", 12, Ui.MUTED, false);
        footView.setGravity(Gravity.CENTER);
        footView.setPadding(0, Ui.dp(this, 18), 0, 0);

        root.addView(card, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        loginBtn = Ui.primary(this, "登录 / 注册", new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MeActivity.this, AuthActivity.class));
            }
        });
        LinearLayout.LayoutParams lp1 = Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp1.topMargin = Ui.dp(this, 18);
        root.addView(loginBtn, lp1);

        outBtn = Ui.ghost(this, "退出登录", new View.OnClickListener() {
            @Override public void onClick(View v) { logout(); }
        });
        LinearLayout.LayoutParams lp2 = Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = Ui.dp(this, 12);
        root.addView(outBtn, lp2);

        root.addView(footView, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        return root;
    }

    private void refresh() {
        boolean logged = Store.logged(this);
        loginBtn.setVisibility(logged ? View.GONE : View.VISIBLE);
        outBtn.setVisibility(logged ? View.VISIBLE : View.GONE);

        if (!logged) {
            nameView.setText("还没登录");
            roleView.setText("登录后就能回帖、发评论");
            footView.setText("");
            return;
        }

        nameView.setText(Store.name(this));
        roleView.setText(describe(Store.role(this), Store.kind(this)));
        footView.setText("");

        Api.get("/api/me", Store.sid(this), new Api.Cb() {
            @Override public void done(JSONObject ok, String err) {
                if (err != null) {
                    footView.setText(err);
                    return;
                }
                String name = Json.s(ok, "name");
                String role = Json.s(ok, "role");
                String kind = Json.s(ok, "kind");
                Store.save(MeActivity.this, Store.sid(MeActivity.this), name, role, kind);
                nameView.setText(name);
                roleView.setText(describe(role, kind));
            }
        });
    }

    private String describe(String role, String kind) {
        StringBuilder sb = new StringBuilder();
        if ("admin".equals(role)) sb.append("站长");
        else sb.append("普通用户");
        if ("pw".equals(kind)) sb.append(" · 邮箱账号");
        else if ("gh".equals(kind)) sb.append(" · GitHub 账号");
        return sb.toString();
    }

    private void logout() {
        JSONObject body = new JSONObject();
        Api.post("/auth/logout", body, Store.sid(this), new Api.Cb() {
            @Override public void done(JSONObject ok, String err) {
                // 服务端删没删会话都无所谓，本地清了就算退出
                Store.clear(MeActivity.this);
                refresh();
            }
        });
    }
}
