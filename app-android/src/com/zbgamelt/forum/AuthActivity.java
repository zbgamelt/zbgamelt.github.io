package com.zbgamelt.forum;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/** 登录 / 注册（邮箱 + 密码，走 /login 与 /register）。 */
public class AuthActivity extends Activity {
    private boolean registerMode = false;

    private TextView tabLogin;
    private TextView tabRegister;
    private EditText nameInput;
    private EditText emailInput;
    private EditText pwInput;
    private TextView errorView;
    private TextView submit;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(buildUi());
        applyMode();
    }

    private View buildUi() {
        LinearLayout root = Ui.column(this);
        root.setBackgroundColor(Ui.BG);
        root.setPadding(Ui.dp(this, 22), Ui.dp(this, 30), Ui.dp(this, 22), Ui.dp(this, 24));

        TextView back = Ui.tv(this, "‹ 返回", 14, Ui.MUTED, false);
        back.setPadding(0, 0, 0, Ui.dp(this, 18));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        root.addView(back);

        TextView title = Ui.tv(this, "登录论坛", 24, Ui.TEXT, true);
        root.addView(title);

        TextView sub = Ui.tv(this, "用你网页版那个邮箱账号就行", 13, Ui.MUTED, false);
        sub.setPadding(0, Ui.dp(this, 6), 0, Ui.dp(this, 22));
        root.addView(sub);

        LinearLayout tabs = new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        tabLogin = Ui.tv(this, "登录", 15, Ui.TEXT, true);
        tabLogin.setGravity(Gravity.CENTER);
        tabLogin.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));
        tabRegister = Ui.tv(this, "注册", 15, Ui.MUTED, false);
        tabRegister.setGravity(Gravity.CENTER);
        tabRegister.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));
        tabs.addView(tabLogin, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        tabs.addView(tabRegister, Ui.lp(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams tp = Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.bottomMargin = Ui.dp(this, 16);
        tabs.setLayoutParams(tp);

        tabLogin.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { registerMode = false; applyMode(); }
        });
        tabRegister.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { registerMode = true; applyMode(); }
        });
        root.addView(tabs);

        nameInput = field("昵称（2-20 个字）", InputType.TYPE_CLASS_TEXT);
        emailInput = field("邮箱", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        pwInput = field("密码（至少 8 位）", InputType.TYPE_TEXT_VARIATION_PASSWORD);

        root.addView(nameInput, spaced());
        root.addView(emailInput, spaced());
        root.addView(pwInput, spaced());

        errorView = Ui.tv(this, "", 13, Ui.DANGER, false);
        errorView.setPadding(0, Ui.dp(this, 4), 0, Ui.dp(this, 10));
        errorView.setVisibility(View.GONE);
        root.addView(errorView);

        submit = Ui.primary(this, "登录", null);
        root.addView(submit, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        submit.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { go(); }
        });

        TextView hint = Ui.tv(this, "也可以在网页版用 GitHub 登录，两边是同一个站点。", 12, Ui.MUTED, false);
        hint.setPadding(0, Ui.dp(this, 16), 0, 0);
        root.addView(hint);

        return root;
    }

    private LinearLayout.LayoutParams spaced() {
        LinearLayout.LayoutParams p = Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        p.bottomMargin = Ui.dp(this, 12);
        return p;
    }

    private EditText field(String hint, int inputType) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(Ui.MUTED);
        e.setTextColor(Ui.TEXT);
        e.setTextSize(15);
        e.setInputType(inputType);
        if (inputType == InputType.TYPE_TEXT_VARIATION_PASSWORD) {
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        }
        e.setBackground(Ui.roundStroke(this, Ui.CARD, 12, Ui.LINE));
        e.setPadding(Ui.dp(this, 14), Ui.dp(this, 13), Ui.dp(this, 14), Ui.dp(this, 13));
        return e;
    }

    private void applyMode() {
        if (registerMode) {
            tabRegister.setTextColor(Ui.TEXT);
            tabRegister.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            tabLogin.setTextColor(Ui.MUTED);
            tabLogin.setTypeface(android.graphics.Typeface.DEFAULT);
            nameInput.setVisibility(View.VISIBLE);
            submit.setText("注册并登录");
        } else {
            tabLogin.setTextColor(Ui.TEXT);
            tabLogin.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            tabRegister.setTextColor(Ui.MUTED);
            tabRegister.setTypeface(android.graphics.Typeface.DEFAULT);
            nameInput.setVisibility(View.GONE);
            submit.setText("登录");
        }
        errorView.setVisibility(View.GONE);
    }

    private void go() {
        final String email = emailInput.getText().toString().trim();
        final String pw = pwInput.getText().toString();
        final String name = nameInput.getText().toString().trim();

        if (email.length() == 0 || pw.length() == 0) {
            showError("邮箱和密码都要填");
            return;
        }
        if (registerMode && name.length() == 0) {
            showError("注册得起个昵称");
            return;
        }

        submit.setEnabled(false);
        submit.setAlpha(0.6f);

        JSONObject body = new JSONObject();
        try {
            body.put("email", email);
            body.put("password", pw);
            if (registerMode) body.put("name", name);
        } catch (Exception ignore) {}

        String path = registerMode ? "/register" : "/login";
        Api.post(path, body, null, new Api.Cb() {
            @Override public void done(JSONObject ok, String err) {
                submit.setEnabled(true);
                submit.setAlpha(1f);
                if (err != null) {
                    showError(err);
                    return;
                }
                Store.save(AuthActivity.this, Json.s(ok, "sid"), Json.s(ok, "name"),
                        Json.s(ok, "role"), "pw");
                setResult(RESULT_OK);
                finish();
            }
        });
    }

    private void showError(String msg) {
        errorView.setText(msg);
        errorView.setVisibility(View.VISIBLE);
    }
}
